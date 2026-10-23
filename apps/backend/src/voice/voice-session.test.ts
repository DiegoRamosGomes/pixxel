import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeminiLiveListeners, GeminiLiveOptions, GeminiLiveState, LiveTurn, ToolCall } from './gemini-live.js';
import type { ToolOutcome } from './tool-executor.js';
import { VoiceSession, type LiveClientLike, type VoiceSessionDeps } from './voice-session.js';

class FakeLive implements LiveClientLike {
  open = false;
  sent: string[] = [];
  toolResponses: Array<{ id: string; name: string; response: Record<string, unknown> }> = [];
  history: LiveTurn[] = [];
  constructor(
    public listeners: GeminiLiveListeners,
    public options: GeminiLiveOptions,
  ) {}
  start = vi.fn(() => {
    this.open = true;
  });
  stop = vi.fn(() => {
    this.open = false;
    this.listeners.onState({ kind: 'idle' });
  });
  isOpen = () => this.open;
  sendAudioChunk = vi.fn();
  endTurn = vi.fn();
  sendText = vi.fn((t: string) => {
    this.sent.push(t);
    return true;
  });
  sendToolResponse = vi.fn((id: string, name: string, response: Record<string, unknown>) => {
    this.toolResponses.push({ id, name, response });
  });
  getHistorySnapshot = () => this.history;
  getPendingRequest = () => undefined;
  getResumptionHandle = () => undefined;
  emitState(s: GeminiLiveState) {
    this.listeners.onState(s);
  }
  emitAudio(b: Buffer) {
    this.listeners.onAudio(b);
  }
  emitToolCall(c: ToolCall) {
    this.listeners.onToolCall?.(c);
  }
  emitTranscript(text: string, role: 'user' | 'model') {
    this.listeners.onTranscript?.(text, role);
  }
  emitEmptyTurn() {
    this.listeners.onEmptyTurn?.();
    this.listeners.onState({ kind: 'ready' });
  }
}

let lives: FakeLive[];
let sink: VoiceSessionDeps['sink'];

function make(over: Partial<VoiceSessionDeps> = {}): VoiceSession {
  return new VoiceSession({
    createLive: vi.fn((l: GeminiLiveListeners, o: GeminiLiveOptions) => {
      const f = new FakeLive(l, o);
      lives.push(f);
      return f;
    }),
    tools: [],
    extraSystemInstruction: () => '',
    executeTool: vi.fn(async (): Promise<ToolOutcome> => ({ response: { ok: true, text: 't' }, widgets: [] })),
    sink,
    isFirstBriefingOfDay: vi.fn(async () => false),
    ...over,
  });
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('VoiceSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    lives = [];
    sink = { state: vi.fn(), audio: vi.fn(), transcript: vi.fn(), widget: vi.fn() };
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sem chave do Gemini fica indisponível', () => {
    const s = make({ unavailableReason: 'GEMINI_API_KEY ausente no servidor' });
    expect(s.start()).toEqual({ ok: false, reason: 'GEMINI_API_KEY ausente no servidor' });
    expect(sink.state).toHaveBeenCalledWith({ kind: 'unavailable', reason: 'GEMINI_API_KEY ausente no servidor' });
    expect(lives).toHaveLength(0);
  });

  it('widget pendente sai antes do primeiro áudio', async () => {
    const executeTool = vi.fn(async (): Promise<ToolOutcome> => ({
      response: { ok: true, text: 't' },
      widgets: [{ widget: { kind: 'weather' } as never, delayMs: 0 }],
    }));
    const s = make({ executeTool });
    s.start();
    lives[0].emitToolCall({ id: '1', name: 'weather', args: {} });
    await flush();
    expect(sink.widget).not.toHaveBeenCalled();
    lives[0].emitAudio(Buffer.alloc(2));
    expect(sink.widget).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sink.widget).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(sink.audio).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(sink.widget).mock.calls[0][0]).toMatchObject({ widget: { kind: 'weather' }, ttlMs: 30_000 });
  });

  it('widget com atraso não espera áudio', async () => {
    const executeTool = vi.fn(async (): Promise<ToolOutcome> => ({
      response: { ok: true },
      widgets: [{ widget: { kind: 'tasks-list' } as never, delayMs: 3000 }],
    }));
    const s = make({ executeTool });
    s.start();
    lives[0].emitToolCall({ id: '1', name: 'morning_briefing', args: {} });
    await vi.advanceTimersByTimeAsync(3000);
    expect(sink.widget).toHaveBeenCalledTimes(1);
  });

  it('suprime tool call duplicada em 1,5 s', async () => {
    const executeTool = vi.fn(async (): Promise<ToolOutcome> => ({ response: { ok: true, text: 't' }, widgets: [] }));
    const s = make({ executeTool });
    s.start();
    lives[0].emitToolCall({ id: '1', name: 'weather', args: { when: 'today' } });
    lives[0].emitToolCall({ id: '2', name: 'weather', args: { when: 'today' } });
    await flush();
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(lives[0].toolResponses.find((r) => r.id === '2')?.response).toEqual({
      ok: true,
      text: '(chamada duplicada suprimida — use a resposta anterior)',
    });
  });

  it('segundo morning_briefing é bloqueado', async () => {
    const executeTool = vi.fn(async (): Promise<ToolOutcome> => ({ response: { ok: true, text: 'b' }, widgets: [] }));
    const s = make({ executeTool });
    s.start();
    lives[0].emitToolCall({ id: '1', name: 'morning_briefing', args: {} });
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    lives[0].emitToolCall({ id: '2', name: 'morning_briefing', args: {} });
    await flush();
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(lives[0].toolResponses.find((r) => r.id === '2')?.response).toEqual({
      ok: false,
      reason: 'Briefing já foi feito nesta sessão',
    });
  });

  it('reconecta com backoff e com o histórico', async () => {
    const turn: LiveTurn = { role: 'user', text: 'oi' };
    const s = make();
    s.start();
    lives[0].history = [turn];
    lives[0].emitState({ kind: 'closed', reason: 'x' });
    await vi.advanceTimersByTimeAsync(1999);
    expect(lives).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(lives).toHaveLength(2);
    expect(lives[1].options.initialHistory).toEqual([turn]);
    expect(lives[1].start).toHaveBeenCalled();
  });

  it('stop emite idle e não reconecta', async () => {
    const s = make();
    s.start();
    s.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lives).toHaveLength(1);
    expect(vi.mocked(sink.state).mock.calls.at(-1)?.[0]).toEqual({ kind: 'idle' });
  });

  it('detach devolve contexto e não emite idle', () => {
    const turn: LiveTurn = { role: 'model', text: 'olá' };
    const s = make();
    s.start();
    lives[0].history = [turn];
    expect(s.detach()).toEqual({ history: [turn], pendingRequest: undefined, resumptionHandle: undefined });
    expect(sink.state).not.toHaveBeenCalledWith({ kind: 'idle' });
  });

  it('recovery do construtor vai para o primeiro live', () => {
    const s = make({ recovery: { resumptionHandle: 'h' } });
    s.start();
    expect(lives[0].options.resumptionHandle).toBe('h');
  });

  it('briefing automático no primeiro ready do dia', async () => {
    const s = make({ isFirstBriefingOfDay: vi.fn(async () => true) });
    s.start();
    lives[0].emitState({ kind: 'ready' });
    await flush();
    expect(lives[0].sent).toContain('Use a tool morning_briefing agora pra me dar meu briefing.');
  });

  it('lembrete quando pergunta de estado não chama current_work_status', async () => {
    const s = make();
    s.start();
    lives[0].emitTranscript('tá rodando ainda?', 'user');
    await vi.advanceTimersByTimeAsync(4000);
    expect(lives[0].sent.some((t) => t.startsWith('[Sistema] O usuário acabou de perguntar sobre estado'))).toBe(true);
  });

  it('chamar current_work_status cancela o lembrete', async () => {
    const s = make();
    s.start();
    lives[0].emitTranscript('tá rodando ainda?', 'user');
    lives[0].emitToolCall({ id: '1', name: 'current_work_status', args: {} });
    await vi.advanceTimersByTimeAsync(4000);
    expect(lives[0].sent.some((t) => t.startsWith('[Sistema]'))).toBe(false);
  });

  it('onReady e onUserActivity', () => {
    const onReady = vi.fn();
    const onUserActivity = vi.fn();
    const s = make({ onReady, onUserActivity });
    s.start();
    lives[0].emitState({ kind: 'ready' });
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(s.isReady()).toBe(true);
    lives[0].emitTranscript('oi', 'user');
    expect(onUserActivity).toHaveBeenCalledTimes(1);
    s.sendText('olá');
    expect(onUserActivity).toHaveBeenCalledTimes(2);
    s.sendInternal('[evento]');
    expect(onUserActivity).toHaveBeenCalledTimes(2);
  });

  it('repassa áudio do microfone e transcrições', () => {
    const s = make();
    s.start();
    s.sendAudio(Buffer.from([1, 2]));
    expect(lives[0].sendAudioChunk).toHaveBeenCalledWith(Buffer.from([1, 2]));
    lives[0].emitTranscript('oi', 'model');
    expect(sink.transcript).toHaveBeenCalledWith('model', 'oi');
  });

  it('texto digitado que volta em turno vazio é reenviado até duas vezes', async () => {
    const s = make();
    s.start();
    lives[0].emitState({ kind: 'ready' });
    s.sendText('Como está o clima hoje?');
    lives[0].emitEmptyTurn();
    expect(lives[0].sent).toEqual(['Como está o clima hoje?', 'Como está o clima hoje?']);
    lives[0].emitEmptyTurn();
    expect(lives[0].sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(lives[0].sent).toHaveLength(3);
    lives[0].emitEmptyTurn();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lives[0].sent).toHaveLength(3);
  });

  it('para de reenviar quando o modelo responde', async () => {
    const s = make();
    s.start();
    lives[0].emitState({ kind: 'ready' });
    s.sendText('Como está o clima hoje?');
    lives[0].emitEmptyTurn();
    lives[0].emitToolCall({ id: '1', name: 'weather', args: {} });
    lives[0].emitEmptyTurn();
    await vi.advanceTimersByTimeAsync(5000);
    expect(lives[0].sent).toHaveLength(2);
  });

  it('não reenvia se o modelo respondeu', () => {
    const s = make();
    s.start();
    lives[0].emitState({ kind: 'ready' });
    s.sendText('oi');
    lives[0].emitAudio(Buffer.alloc(2));
    lives[0].emitEmptyTurn();
    expect(lives[0].sent).toEqual(['oi']);
  });

  it('turno vazio sem texto digitado não reenvia nada', () => {
    const s = make();
    s.start();
    lives[0].emitState({ kind: 'ready' });
    s.sendInternal('[evento interno] build terminou');
    lives[0].emitEmptyTurn();
    expect(lives[0].sent).toEqual(['[evento interno] build terminou']);
  });

  it('enquanto reenvia, o cliente continua vendo a sessão ocupada', async () => {
    const s = make();
    s.start();
    lives[0].emitState({ kind: 'ready' });
    vi.mocked(sink.state).mockClear();
    s.sendText('Como está o clima hoje?');
    lives[0].emitEmptyTurn();
    lives[0].emitEmptyTurn();
    expect(sink.state).not.toHaveBeenCalledWith({ kind: 'ready' });
    await vi.advanceTimersByTimeAsync(1000);
    lives[0].emitEmptyTurn();
    expect(sink.state).toHaveBeenCalledWith({ kind: 'ready' });
  });
});
