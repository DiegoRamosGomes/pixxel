// Sessão de voz (Gemini Live) de UM cliente conectado.
//
// Portado do orquestrador que vivia no main do Electron: reconexão com
// backoff, contexto de retomada entre conexões, dedup de tool calls,
// briefing automático no primeiro ready do dia, lembrete de
// current_work_status e widgets sincronizados com o início da fala.
//
// O áudio entra por sendAudio (PCM16 16 kHz do microfone) e sai pelo sink
// (PCM16 24 kHz) — esse é o único caminho de áudio, isolado aqui pra poder
// ser trocado depois por conexão direta cliente→Gemini.

import { randomUUID } from 'node:crypto';
import type { LiveState, Widget } from '@assistant/shared';
import type {
  GeminiLiveListeners,
  GeminiLiveOptions,
  GeminiLiveState,
  LivePendingRequest,
  LiveTurn,
  ToolCall,
  ToolDeclaration,
} from './gemini-live.js';
import type { LiveRecoveryContext, VoiceSessionHandle } from '../clients/client-registry.js';
import type { ToolOutcome } from './tool-executor.js';
import { ttlForWidget } from './widget-ttl.js';

export interface LiveClientLike {
  start(): void;
  stop(): void;
  isOpen(): boolean;
  sendAudioChunk(pcm16k: Buffer): void;
  endTurn(): void;
  sendText(text: string): boolean;
  sendToolResponse(id: string, name: string, response: Record<string, unknown>): void;
  getHistorySnapshot(): LiveTurn[];
  getPendingRequest(): LivePendingRequest | undefined;
  getResumptionHandle(): string | undefined;
}

export type LiveClientFactory = (
  listeners: GeminiLiveListeners,
  options: GeminiLiveOptions,
) => LiveClientLike;

type QueuedWidget = { id: string; widget: Widget; ttlMs: number };

export type VoiceSessionDeps = {
  createLive: LiveClientFactory;
  /** Quando definido, a voz não sobe (ex.: falta GEMINI_API_KEY). */
  unavailableReason?: string;
  tools: ToolDeclaration[];
  extraSystemInstruction(): string;
  executeTool(call: ToolCall): Promise<ToolOutcome>;
  sink: {
    state(s: LiveState): void;
    audio(pcm24k: Buffer): void;
    transcript(role: 'user' | 'model', text: string): void;
    widget(w: QueuedWidget): void;
    /** Fala do modelo cortada pelo usuário: o cliente para o áudio já enfileirado. */
    interrupted(): void;
  };
  isFirstBriefingOfDay(): Promise<boolean>;
  onReady?(): void;
  onUserActivity?(): void;
  recovery?: LiveRecoveryContext;
  reconnectDelaysMs?: number[];
};

const DEFAULT_RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000];
// Gemini Live às vezes dispara a mesma tool com os mesmos args duas vezes em
// poucos ms (paralelismo espúrio ou retry interno).
const TOOL_DEDUP_MS = 1500;
const STATE_CHECK_DELAY_MS = 4000;
// Reenvio do texto digitado quando o Gemini devolve turno vazio: na hora e,
// se vier vazio de novo, depois de 1 s.
const EMPTY_TURN_RETRY_DELAYS_MS = [0, 1000];

export class VoiceSession implements VoiceSessionHandle {
  private live: LiveClientLike | null = null;
  private state: GeminiLiveState['kind'] = 'idle';
  /** Intenção do usuário: true entre start() e stop(). */
  private desired = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private recovery: LiveRecoveryContext | null;
  /** Cinta do briefing: no máximo 1 por conexão Live. */
  private briefingHandled = false;
  private pendingStateCheck: NodeJS.Timeout | null = null;
  /**
   * Último texto digitado ainda sem resposta. O modelo de áudio nativo às
   * vezes fecha o turno com 1 token e nada mais; reenviamos até
   * EMPTY_TURN_RETRY_DELAYS_MS.length vezes.
   */
  private retry: { text: string; attempts: number } | null = null;
  /** O `ready` do turno vazio que vai ser reenviado não chega ao cliente (orb segue "pensando"). */
  private hideNextReady = false;
  private lastCurrentWorkStatusAtMs = 0;
  private readonly delays: number[];

  constructor(private readonly deps: VoiceSessionDeps) {
    this.recovery = deps.recovery ?? null;
    this.delays = deps.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  }

  start(): { ok: boolean; reason?: string } {
    if (this.deps.unavailableReason) {
      const reason = this.deps.unavailableReason;
      this.deps.sink.state({ kind: 'unavailable', reason });
      return { ok: false, reason };
    }
    this.desired = true;
    this.cancelReconnect();
    return this.startLive();
  }

  stop(): void {
    this.desired = false;
    this.retry = null;
    this.cancelReconnect();
    this.clearStateCheck();
    const old = this.live;
    this.live = null;
    this.state = 'idle';
    this.recovery = null;
    old?.stop();
    this.deps.sink.state({ kind: 'idle' });
  }

  detach(): LiveRecoveryContext | null {
    this.desired = false;
    this.retry = null;
    this.cancelReconnect();
    this.clearStateCheck();
    const old = this.live;
    this.live = null;
    this.state = 'idle';
    let ctx = this.recovery;
    if (old) {
      ctx = {
        history: old.getHistorySnapshot(),
        pendingRequest: old.getPendingRequest(),
        resumptionHandle: old.getResumptionHandle(),
      };
      old.stop();
    }
    this.recovery = null;
    return ctx;
  }

  sendAudio(pcm16k: Buffer): void {
    this.live?.sendAudioChunk(pcm16k);
  }

  endTurn(): void {
    this.live?.endTurn();
  }

  sendText(text: string): boolean {
    this.deps.onUserActivity?.();
    const sent = this.live?.sendText(text) ?? false;
    this.retry = sent ? { text, attempts: 0 } : null;
    console.log(`[voice] texto do usuário (${sent ? 'enviado' : 'NÃO enviado'}): "${text.slice(0, 80)}"`);
    return sent;
  }

  sendInternal(text: string): boolean {
    this.retry = null;
    return this.live?.sendText(text) ?? false;
  }

  isReady(): boolean {
    return this.state === 'ready' || this.state === 'speaking';
  }

  private startLive(): { ok: boolean; reason?: string } {
    if (this.live) {
      if (this.live.isOpen()) return { ok: true };
      // Cliente pendurado (ws travado, setup não completou): força cleanup.
      const hung = this.live;
      this.live = null;
      try {
        hung.stop();
      } catch (err) {
        console.warn('[voice] erro no stop forçado (ignorado):', err);
      }
    }
    // Nova conexão Live pode ter briefing de novo (o disco evita duplicar no dia).
    this.briefingHandled = false;
    // Widgets esperam o primeiro chunk de áudio depois da tool call pra
    // aparecerem junto com a fala, não quando a integração termina.
    const pendingWidgets: QueuedWidget[] = [];
    const recentCalls = new Map<string, number>();

    let client: LiveClientLike | null = null;
    const isCurrent = (): boolean => client !== null && this.live === client;

    const listeners: GeminiLiveListeners = {
      onState: (state) => {
        if (!isCurrent()) return;
        this.onLiveState(client!, state);
      },
      onAudio: (pcm) => {
        if (!isCurrent()) return;
        this.retry = null;
        for (const w of pendingWidgets.splice(0)) this.deps.sink.widget(w);
        this.deps.sink.audio(pcm);
      },
      onTranscript: (text, role) => {
        if (!isCurrent()) return;
        this.deps.sink.transcript(role, text);
        if (role === 'user') {
          this.deps.onUserActivity?.();
          this.watchStateQuestion(text);
        }
      },
      onToolCall: (call) => {
        if (!isCurrent()) return;
        this.retry = null;
        void this.handleToolCall(client!, call, pendingWidgets, recentCalls);
      },
    };

    listeners.onInterrupted = () => {
      if (!isCurrent()) return;
      // Widget que esperava o primeiro áudio perdeu o sentido: a fala foi cortada.
      pendingWidgets.length = 0;
      this.deps.sink.interrupted();
    };

    listeners.onEmptyTurn = () => {
      const retry = this.retry;
      if (!isCurrent() || !retry) return;
      if (retry.attempts >= EMPTY_TURN_RETRY_DELAYS_MS.length) {
        console.warn(`[voice] turno vazio de novo — desistindo de "${retry.text.slice(0, 60)}"`);
        this.retry = null;
        return;
      }
      const delay = EMPTY_TURN_RETRY_DELAYS_MS[retry.attempts];
      retry.attempts += 1;
      this.hideNextReady = true;
      console.warn(`[voice] turno vazio do Gemini — reenviando (${retry.attempts}): "${retry.text.slice(0, 60)}"`);
      const resend = (): void => {
        if (isCurrent() && this.retry === retry) client!.sendText(retry.text);
      };
      if (delay > 0) setTimeout(resend, delay);
      else resend();
    };

    const recovery = this.recovery;
    client = this.deps.createLive(listeners, {
      tools: this.deps.tools,
      extraSystemInstruction: this.deps.extraSystemInstruction(),
      initialHistory: recovery?.history,
      pendingRequest: recovery?.pendingRequest,
      resumptionHandle: recovery?.resumptionHandle,
    });
    this.live = client;
    client.start();
    return { ok: true };
  }

  private onLiveState(client: LiveClientLike, state: GeminiLiveState): void {
    this.state = state.kind;
    if (state.kind === 'ready' && this.hideNextReady) {
      this.hideNextReady = false;
      return;
    }
    this.hideNextReady = false;
    this.deps.sink.state(state);

    if (state.kind === 'ready') {
      // Conexão estabelecida: zera o retry e consome o contexto de retomada.
      this.reconnectAttempt = 0;
      this.recovery = null;
      this.deps.onReady?.();
      if (!this.briefingHandled) void this.maybeAutoBriefing(client);
      return;
    }

    if (state.kind === 'closed' || state.kind === 'error') {
      // Captura o contexto antes de descartar o cliente, pra próxima conexão
      // retomar (replay do histórico + handle de resumption do Gemini).
      const history = client.getHistorySnapshot();
      const pendingRequest = client.getPendingRequest();
      const resumptionHandle = client.getResumptionHandle();
      if (history.length > 0 || pendingRequest || resumptionHandle) {
        this.recovery = { history, pendingRequest, resumptionHandle };
      }
      this.live = null;
      if (this.desired) this.scheduleReconnect();
      return;
    }

    if (state.kind === 'idle') {
      this.recovery = null;
      this.live = null;
    }
  }

  private async maybeAutoBriefing(client: LiveClientLike): Promise<void> {
    try {
      const firstToday = await this.deps.isFirstBriefingOfDay();
      if (!firstToday || this.briefingHandled) return;
      if (this.live !== client || !client.isOpen()) return;
      // Pede pro Gemini chamar a tool — o fluxo normal cuida de áudio,
      // widgets e da marcação do briefing.
      client.sendText('Use a tool morning_briefing agora pra me dar meu briefing.');
    } catch (err) {
      console.warn('[voice] auto-briefing falhou:', err);
    }
  }

  private async handleToolCall(
    client: LiveClientLike,
    call: ToolCall,
    pendingWidgets: QueuedWidget[],
    recentCalls: Map<string, number>,
  ): Promise<void> {
    const key = `${call.name}:${JSON.stringify(call.args)}`;
    const now = Date.now();
    const prev = recentCalls.get(key);
    if (prev !== undefined && now - prev < TOOL_DEDUP_MS) {
      client.sendToolResponse(call.id, call.name, {
        ok: true,
        text: '(chamada duplicada suprimida — use a resposta anterior)',
      });
      return;
    }
    recentCalls.set(key, now);
    for (const [k, at] of recentCalls) {
      if (now - at > TOOL_DEDUP_MS * 4) recentCalls.delete(k);
    }

    if (call.name === 'morning_briefing' && this.briefingHandled) {
      client.sendToolResponse(call.id, call.name, {
        ok: false,
        reason: 'Briefing já foi feito nesta sessão',
      });
      return;
    }

    if (call.name === 'current_work_status') {
      // Gemini consultou o estado — cancela o lembrete pendente.
      this.lastCurrentWorkStatusAtMs = Date.now();
      this.clearStateCheck();
    }

    console.log(`[voice] tool call: ${call.name} ${JSON.stringify(call.args)}`);
    const startedAt = Date.now();
    let out: ToolOutcome;
    try {
      out = await this.deps.executeTool(call);
    } catch (err) {
      out = { response: { ok: false, reason: err instanceof Error ? err.message : String(err) }, widgets: [] };
    }
    console.log(
      `[voice] tool ${call.name} → ok=${String(out.response.ok)} em ${Date.now() - startedAt}ms` +
        (out.response.ok ? '' : ` (${String(out.response.reason)})`),
    );

    if (call.name === 'morning_briefing' && out.response.ok === true) this.briefingHandled = true;

    for (const { widget, delayMs } of out.widgets) {
      const queued = { id: randomUUID(), widget, ttlMs: ttlForWidget(widget.kind) };
      if (delayMs > 0) {
        // Widgets atrasados não passam pela fila de áudio: a fala já começou.
        setTimeout(() => this.deps.sink.widget(queued), delayMs);
      } else {
        pendingWidgets.push(queued);
      }
    }

    if (this.live === client) client.sendToolResponse(call.id, call.name, out.response);
  }

  /** Pergunta de estado ("tá rodando?") sem current_work_status em 4 s → lembrete. */
  private watchStateQuestion(text: string): void {
    const norm = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
    const stateQuestion =
      /\b(ta|esta|tem alguma|terminou|terminei|pronto|tem alguma coisa|no que|qual.*tarefa|tarefa atual|sessao|ainda|ja terminou|continua|fez|fizemos|criou|salvou)\b/.test(
        norm,
      ) &&
      (/\?/.test(text) || /\b(rodando|em andamento|trabalh|fazendo|atual|ativ|aberto)\b/.test(norm));
    if (!stateQuestion) return;
    this.clearStateCheck();
    const detectedAt = Date.now();
    this.pendingStateCheck = setTimeout(() => {
      this.pendingStateCheck = null;
      if (this.lastCurrentWorkStatusAtMs >= detectedAt) return;
      console.warn('[guard] usuário perguntou sobre estado mas Gemini não chamou current_work_status. Mandando lembrete.');
      this.live?.sendText(
        '[Sistema] O usuário acabou de perguntar sobre estado de ' +
          'tarefa. Você NÃO chamou current_work_status — então NÃO ' +
          'sabe a verdade. Chame current_work_status AGORA antes de ' +
          'responder. Se já respondeu errado, corrija.',
      );
    }, STATE_CHECK_DELAY_MS);
  }

  private clearStateCheck(): void {
    if (this.pendingStateCheck) {
      clearTimeout(this.pendingStateCheck);
      this.pendingStateCheck = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.desired) return;
    const delay = this.delays[Math.min(this.reconnectAttempt, this.delays.length - 1)];
    this.reconnectAttempt += 1;
    console.warn(`[voice] reconnect agendado em ${delay / 1000}s (tentativa ${this.reconnectAttempt})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.desired) return;
      const r = this.startLive();
      if (!r.ok) this.scheduleReconnect();
    }, delay);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
  }
}
