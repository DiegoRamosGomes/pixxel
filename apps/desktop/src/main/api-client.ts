// Conexão do Electron com a API (o Pixxel de verdade roda no servidor).
//
// Um WebSocket: JSON pra controle e frames binários pro áudio (microfone vai
// em PCM16 16 kHz, a fala volta em PCM16 24 kHz). A API pede operações locais
// (abrir app, mexer no mouse...) com local_tool_call; o cliente executa e
// devolve local_tool_result com o mesmo callId.

import WebSocket from 'ws';
import {
  ApiServerMessageSchema,
  PROTOCOL_VERSION,
  SPEAKER_SAMPLE_RATE,
  type ApiClientMessage,
  type ApiServerMessage,
  type LocalOp,
  type LocalToolResult,
} from '@assistant/shared';
import type { RendererEvent } from '../shared/ipc.js';

export type ApiClientOptions = {
  /** Base HTTP da API, ex.: http://localhost:8080 */
  apiUrl: string;
  token: string;
  clientId: string;
  localOps: LocalOp[];
  emit(e: RendererEvent): void;
  runLocalOp(op: LocalOp, args: Record<string, unknown>): Promise<LocalToolResult>;
  reconnectDelaysMs?: number[];
  /** A API avisa quando a apresentação começa/termina (o Esc só vale nesse período). */
  onPresentationState?(running: boolean): void;
  /** De quanto em quanto tempo pinga a API e quanto espera o pong. */
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
};

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000];
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

export class ApiClient {
  private ws: WebSocket | null = null;
  private authed = false;
  private closedByUser = false;
  /** Intenção do usuário de ter a voz ligada — sobrevive a quedas da API. */
  private voiceDesired = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private presentationRunning = false;
  private heartbeat: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private readonly delays: number[];

  constructor(private readonly opts: ApiClientOptions) {
    this.delays = opts.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS_MS;
  }

  connect(): void {
    if (this.ws) return;
    this.closedByUser = false;
    const url = this.opts.apiUrl.replace(/^http/, 'ws').replace(/\/$/, '') + '/ws';
    this.opts.emit({ type: 'conn', state: 'connecting' });
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.startHeartbeat(ws);
      this.send({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        token: this.opts.token,
        clientId: this.opts.clientId,
        clientKind: 'desktop',
        localOps: this.opts.localOps,
      });
    });

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        // Cópia própria: o Buffer do ws pode ser um slice de um pool maior.
        const pcm = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
        this.opts.emit({ type: 'live_audio', pcm, sampleRate: SPEAKER_SAMPLE_RATE });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        console.warn('[api] mensagem inválida da API');
        return;
      }
      const r = ApiServerMessageSchema.safeParse(parsed);
      if (!r.success) {
        console.warn('[api] mensagem fora do protocolo:', r.error.message);
        return;
      }
      this.onMessage(r.data);
    });

    ws.on('pong', () => {
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.stopHeartbeat();
      this.setPresentationRunning(false);
      this.ws = null;
      this.authed = false;
      this.opts.emit({ type: 'conn', state: 'closed', reason: reason.toString() || `code ${code}` });
      if (!this.closedByUser) this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      this.opts.emit({ type: 'conn', state: 'error', reason: err.message });
    });
  }

  close(): void {
    this.closedByUser = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    this.authed = false;
    ws?.close();
  }

  voiceStart(): void {
    this.voiceDesired = true;
    if (this.authed) this.send({ type: 'voice_start' });
  }

  voiceStop(): void {
    this.voiceDesired = false;
    if (this.authed) this.send({ type: 'voice_stop' });
  }

  sendAudio(pcm16k: ArrayBuffer): void {
    if (!this.authed || !this.ws) return;
    this.ws.send(Buffer.from(pcm16k), { binary: true });
  }

  sendText(text: string): { ok: boolean; reason?: string } {
    if (!this.authed) return { ok: false, reason: 'api_offline' };
    this.send({ type: 'voice_text', text });
    return { ok: true };
  }

  endTurn(): void {
    if (this.authed) this.send({ type: 'voice_end_turn' });
  }

  explainClickupTask(taskId: string): void {
    if (this.authed) this.send({ type: 'explain_clickup_task', taskId });
  }

  abortPresentation(): void {
    if (this.authed) this.send({ type: 'presentation_abort' });
  }

  async memoryGraph(): Promise<{ nodes: unknown[]; edges: unknown[] }> {
    try {
      const res = await fetch(this.http('/api/memory-graph'), { headers: this.authHeader() });
      if (!res.ok) return { nodes: [], edges: [] };
      return (await res.json()) as { nodes: unknown[]; edges: unknown[] };
    } catch (err) {
      console.warn('[api] memory-graph falhou:', err);
      return { nodes: [], edges: [] };
    }
  }

  async instagramPublish(
    bytes: ArrayBuffer,
    fileName: string,
    caption: string,
    shareToFeed: boolean,
  ): Promise<{ ok: boolean; reason?: string; permalink?: string }> {
    try {
      const res = await fetch(this.http('/api/instagram/publish'), {
        method: 'POST',
        headers: {
          ...this.authHeader(),
          'content-type': 'application/octet-stream',
          'x-file-name': fileName,
          'x-caption': encodeURIComponent(caption),
          'x-share-to-feed': String(shareToFeed),
        },
        body: Buffer.from(bytes),
      });
      return (await res.json()) as { ok: boolean; reason?: string; permalink?: string };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : 'API indisponível' };
    }
  }

  private onMessage(msg: ApiServerMessage): void {
    switch (msg.type) {
      case 'hello_ok':
        this.authed = true;
        this.reconnectAttempt = 0;
        this.opts.emit({ type: 'conn', state: 'open' });
        // Voz continuava desejada (queda da API, servidor reiniciou): religa.
        if (this.voiceDesired) this.send({ type: 'voice_start' });
        return;
      case 'error':
        console.warn(`[api] erro ${msg.code}: ${msg.message}`);
        if (msg.code === 'voice_not_ready') {
          this.opts.emit({ type: 'live_state', state: { kind: 'error', code: msg.code, message: msg.message } });
        }
        return;
      case 'voice_state':
        this.opts.emit({ type: 'live_state', state: msg.state });
        return;
      case 'voice_interrupted':
        this.opts.emit({ type: 'live_interrupted' });
        return;
      case 'transcript':
        this.opts.emit({ type: 'live_transcript', role: msg.role, text: msg.text });
        return;
      case 'widget':
        this.opts.emit({ type: 'widget', id: msg.id, widget: msg.widget, ttlMs: msg.ttlMs });
        return;
      case 'widget_dismiss':
        this.opts.emit({ type: 'widget_dismiss', id: msg.id });
        return;
      case 'local_tool_call':
        void this.runLocal(msg.callId, msg.name, msg.args);
        return;
      case 'presentation_state':
        this.setPresentationRunning(msg.running);
        return;
    }
  }

  private setPresentationRunning(running: boolean): void {
    if (this.presentationRunning === running) return;
    this.presentationRunning = running;
    this.opts.onPresentationState?.(running);
  }

  private async runLocal(callId: string, op: LocalOp, args: Record<string, unknown>): Promise<void> {
    let result: LocalToolResult;
    try {
      result = await this.opts.runLocalOp(op, args);
    } catch (err) {
      result = { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
    this.send({ type: 'local_tool_result', callId, result });
  }

  private send(msg: ApiClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /**
   * Conexão meio-aberta (troca de rede, servidor sumiu sem FIN) parece "open"
   * pra sempre. Sem pong no prazo → terminate, que dispara o close e o reconnect.
   */
  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    const timeoutMs = this.opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.heartbeat = setInterval(() => {
      if (this.pongTimer) return; // ainda esperando o pong anterior
      this.pongTimer = setTimeout(() => {
        console.warn('[api] sem pong da API — reconectando');
        ws.terminate();
      }, timeoutMs);
      try {
        ws.ping();
      } catch {
        /* socket já fechando */
      }
    }, this.opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.heartbeat = null;
    this.pongTimer = null;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.delays[Math.min(this.reconnectAttempt, this.delays.length - 1)];
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.connect();
    }, delay);
  }

  private http(path: string): string {
    return this.opts.apiUrl.replace(/\/$/, '') + path;
  }

  private authHeader(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}` };
  }
}
