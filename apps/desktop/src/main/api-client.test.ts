import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import type { RendererEvent } from '../shared/ipc.js';
import { ApiClient, type ApiClientOptions } from './api-client.js';

let wss: WebSocketServer;
let port: number;
let sockets: WebSocket[];
let received: Array<Record<string, unknown>>;
let client: ApiClient | null;

beforeEach(async () => {
  sockets = [];
  received = [];
  client = null;
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  port = (wss.address() as AddressInfo).port;
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (d, bin) => {
      if (!bin) received.push(JSON.parse(d.toString()));
    });
  });
});

afterEach(async () => {
  client?.close();
  for (const s of sockets) s.terminate();
  await new Promise<void>((r) => wss.close(() => r()));
});

function make(over: Partial<ApiClientOptions> = {}) {
  const events: RendererEvent[] = [];
  client = new ApiClient({
    apiUrl: `http://127.0.0.1:${port}`,
    token: 'tok-123456',
    clientId: 'desktop-test',
    localOps: ['open_app'],
    emit: (e) => events.push(e),
    runLocalOp: vi.fn(async () => ({ ok: true as const })),
    reconnectDelaysMs: [10],
    ...over,
  });
  return { c: client, events };
}

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('timeout esperando condição');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const helloOk = (ws: WebSocket) => ws.send(JSON.stringify({ type: 'hello_ok', clientId: 'desktop-test' }));

describe('ApiClient', () => {
  it('envia hello com token, clientId e localOps', async () => {
    const { c } = make();
    c.connect();
    await until(() => received.length > 0);
    expect(received[0]).toEqual({
      type: 'hello',
      protocolVersion: 2,
      token: 'tok-123456',
      clientId: 'desktop-test',
      clientKind: 'desktop',
      localOps: ['open_app'],
    });
  });

  it('conn open só depois de hello_ok', async () => {
    const { c, events } = make();
    c.connect();
    await until(() => sockets.length > 0 && received.length > 0);
    expect(events).toContainEqual({ type: 'conn', state: 'connecting' });
    expect(events.some((e) => e.type === 'conn' && e.state === 'open')).toBe(false);
    helloOk(sockets[0]);
    await until(() => events.some((e) => e.type === 'conn' && e.state === 'open'));
  });

  it('responde local_tool_call com o mesmo callId', async () => {
    const runLocalOp = vi.fn(async () => ({ ok: true as const, text: 'Abri.' }));
    const { c } = make({ runLocalOp });
    c.connect();
    await until(() => received.length > 0);
    helloOk(sockets[0]);
    sockets[0].send(JSON.stringify({ type: 'local_tool_call', callId: 'c1', name: 'open_app', args: { name: 'x' } }));
    await until(() => received.some((m) => m.type === 'local_tool_result'));
    expect(runLocalOp).toHaveBeenCalledWith('open_app', { name: 'x' });
    expect(received.find((m) => m.type === 'local_tool_result')).toEqual({
      type: 'local_tool_result',
      callId: 'c1',
      result: { ok: true, text: 'Abri.' },
    });
  });

  it('exceção do executor vira ok:false', async () => {
    const runLocalOp = vi.fn(async () => {
      throw new Error('boom');
    });
    const { c } = make({ runLocalOp });
    c.connect();
    await until(() => received.length > 0);
    helloOk(sockets[0]);
    sockets[0].send(JSON.stringify({ type: 'local_tool_call', callId: 'c2', name: 'open_app', args: {} }));
    await until(() => received.some((m) => m.type === 'local_tool_result'));
    expect(received.find((m) => m.type === 'local_tool_result')?.result).toEqual({ ok: false, reason: 'boom' });
  });

  it('áudio binário vira live_audio 24 kHz', async () => {
    const { c, events } = make();
    c.connect();
    await until(() => received.length > 0);
    helloOk(sockets[0]);
    sockets[0].send(Buffer.from([1, 0]), { binary: true });
    await until(() => events.some((e) => e.type === 'live_audio'));
    const ev = events.find((e) => e.type === 'live_audio') as Extract<RendererEvent, { type: 'live_audio' }>;
    expect(ev.sampleRate).toBe(24000);
    expect(ev.pcm.byteLength).toBe(2);
  });

  it('mensagens de voz e widget viram eventos da janela', async () => {
    const { c, events } = make();
    c.connect();
    await until(() => received.length > 0);
    helloOk(sockets[0]);
    sockets[0].send(JSON.stringify({ type: 'voice_state', state: { kind: 'ready' } }));
    sockets[0].send(JSON.stringify({ type: 'transcript', role: 'model', text: 'oi' }));
    sockets[0].send(JSON.stringify({ type: 'widget', id: 'w1', widget: { kind: 'weather' }, ttlMs: 30000 }));
    sockets[0].send(JSON.stringify({ type: 'voice_interrupted' }));
    sockets[0].send(JSON.stringify({ type: 'widget_dismiss', id: 'w1' }));
    await until(() => events.some((e) => e.type === 'widget_dismiss'));
    expect(events).toContainEqual({ type: 'live_interrupted' });
    expect(events).toContainEqual({ type: 'live_state', state: { kind: 'ready' } });
    expect(events).toContainEqual({ type: 'live_transcript', role: 'model', text: 'oi' });
    expect(events).toContainEqual({ type: 'widget', id: 'w1', widget: { kind: 'weather' }, ttlMs: 30000 });
  });

  it('reconecta e reenvia voice_start quando a voz estava ligada', async () => {
    const { c, events } = make();
    c.connect();
    await until(() => received.length > 0);
    helloOk(sockets[0]);
    c.voiceStart();
    await until(() => received.some((m) => m.type === 'voice_start'));
    received.length = 0;
    sockets[0].close();
    await until(() => events.some((e) => e.type === 'conn' && e.state === 'closed'));
    await until(() => sockets.length === 2 && received.some((m) => m.type === 'hello'));
    helloOk(sockets[1]);
    await until(() => received.some((m) => m.type === 'voice_start'));
  });

  it('sendText offline', () => {
    const { c } = make();
    expect(c.sendText('oi')).toEqual({ ok: false, reason: 'api_offline' });
  });
});

describe('ApiClient heartbeat', () => {
  it('derruba e reconecta quando a API não responde ping', async () => {
    // Servidor que não responde ping (conexão meio-aberta após troca de rede).
    const mute = new WebSocketServer({ port: 0, autoPong: false });
    await new Promise<void>((r) => mute.once('listening', () => r()));
    const mutePort = (mute.address() as AddressInfo).port;
    const conns: WebSocket[] = [];
    mute.on('connection', (ws) => {
      conns.push(ws);
      ws.send(JSON.stringify({ type: 'hello_ok', clientId: 'desktop-test' }));
    });
    const events: RendererEvent[] = [];
    const c = new ApiClient({
      apiUrl: `http://127.0.0.1:${mutePort}`,
      token: 'tok-123456',
      clientId: 'desktop-test',
      localOps: [],
      emit: (e) => events.push(e),
      runLocalOp: vi.fn(async () => ({ ok: true as const })),
      reconnectDelaysMs: [10],
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 50,
    });
    try {
      c.connect();
      await until(() => events.some((e) => e.type === 'conn' && e.state === 'open'));
      await until(() => events.some((e) => e.type === 'conn' && e.state === 'closed'), 3000);
      await until(() => conns.length >= 2, 3000);
    } finally {
      c.close();
      for (const s of conns) s.terminate();
      await new Promise<void>((r) => mute.close(() => r()));
    }
  });
});

describe('ApiClient apresentação', () => {
  it('repassa presentation_state e desliga ao cair a conexão', async () => {
    const states: boolean[] = [];
    const { c } = make({ onPresentationState: (running) => states.push(running) });
    c.connect();
    await until(() => received.length > 0);
    helloOk(sockets[0]);
    sockets[0].send(JSON.stringify({ type: 'presentation_state', running: true }));
    await until(() => states.length === 1);
    expect(states).toEqual([true]);
    sockets[0].close();
    await until(() => states.length === 2);
    expect(states).toEqual([true, false]);
  });
});
