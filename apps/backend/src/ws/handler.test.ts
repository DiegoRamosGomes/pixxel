import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type WebSocket from 'ws';
import {
  ClientRegistry,
  type ConnectedClient,
  type LiveRecoveryContext,
  type VoiceSessionHandle,
} from '../clients/client-registry.js';
import { handleConnection, type HandlerDeps } from './handler.js';

const TOKEN = 'token-de-teste-123';

type FakeSession = { [K in keyof VoiceSessionHandle]: Mock<VoiceSessionHandle[K]> };

function fakeSession(): FakeSession {
  return {
    start: vi.fn(() => ({ ok: true })),
    stop: vi.fn(),
    detach: vi.fn(() => null),
    sendAudio: vi.fn(),
    endTurn: vi.fn(),
    sendText: vi.fn(() => true),
    sendInternal: vi.fn(() => true),
    isReady: vi.fn(() => true),
  };
}

let app: FastifyInstance;

async function setup(over: Partial<HandlerDeps> = {}) {
  app = Fastify();
  await app.register(websocket);
  const registry = new ClientRegistry();
  const sessions: FakeSession[] = [];
  const createSession = vi.fn((_c: ConnectedClient, _r: LiveRecoveryContext | undefined) => {
    const s = fakeSession();
    sessions.push(s);
    return s;
  });
  const deps: HandlerDeps = {
    token: TOKEN,
    registry,
    localToolTimeoutMs: 5000,
    createSession,
    onPresentationAbort: vi.fn(),
    ...over,
  };
  app.get('/ws', { websocket: true }, (socket) => handleConnection(socket, deps));
  await app.ready();
  return { registry, sessions, createSession, deps };
}

function next(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(JSON.parse(d.toString()))));
}

function closed(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

const hello = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'hello',
    protocolVersion: 2,
    token: TOKEN,
    clientId: 'desktop-mac',
    clientKind: 'desktop',
    localOps: ['open_app'],
    ...over,
  });

async function connect(over: Record<string, unknown> = {}): Promise<WebSocket> {
  const ws = await app.injectWS('/ws');
  const ok = next(ws);
  ws.send(hello(over));
  expect(await ok).toEqual({ type: 'hello_ok', clientId: (over.clientId as string) ?? 'desktop-mac' });
  return ws;
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe('handler WebSocket', () => {
  afterEach(async () => {
    await app?.close();
  });

  it('token errado recebe unauthorized e fecha 1008', async () => {
    await setup();
    const ws = await app.injectWS('/ws');
    const msg = next(ws);
    const code = closed(ws);
    ws.send(hello({ token: 'errado' }));
    expect(await msg).toMatchObject({ type: 'error', code: 'unauthorized' });
    expect(await code).toBe(1008);
  });

  it('mensagem antes do hello é recusada', async () => {
    await setup();
    const ws = await app.injectWS('/ws');
    const msg = next(ws);
    ws.send(JSON.stringify({ type: 'voice_start' }));
    expect(await msg).toEqual({ type: 'error', code: 'unauthorized', message: 'send hello first' });
    ws.terminate();
  });

  it('protocolVersion diferente fecha', async () => {
    await setup();
    const ws = await app.injectWS('/ws');
    const msg = next(ws);
    const code = closed(ws);
    ws.send(hello({ protocolVersion: 1 }));
    expect(await msg).toMatchObject({ type: 'error', code: 'protocol_mismatch' });
    expect(await code).toBe(1008);
  });

  it('sem hello no prazo fecha 1008', async () => {
    await setup({ helloTimeoutMs: 50 });
    const ws = await app.injectWS('/ws');
    expect(await closed(ws)).toBe(1008);
  });

  it('hello ok e voice_start cria sessão com as operações declaradas', async () => {
    const { createSession, sessions } = await setup();
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'voice_start' }));
    await tick();
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(createSession.mock.calls[0][0]).toMatchObject({ clientId: 'desktop-mac', localOps: ['open_app'] });
    expect(sessions[0].start).toHaveBeenCalled();
    ws.terminate();
  });

  it('frame binário vai para sendAudio', async () => {
    const { sessions } = await setup();
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'voice_start' }));
    await tick();
    ws.send(Buffer.from([1, 2]), { binary: true });
    await tick();
    expect(sessions[0].sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2]));
    ws.terminate();
  });

  it('local_tool_result resolve a chamada pendente', async () => {
    const { registry } = await setup();
    const ws = await connect();
    const callMsg = next(ws);
    const p = registry.get('desktop-mac')!.bridge.call('open_app', { name: 'x' });
    const m = await callMsg;
    expect(m).toMatchObject({ type: 'local_tool_call', name: 'open_app', args: { name: 'x' } });
    ws.send(JSON.stringify({ type: 'local_tool_result', callId: m.callId, result: { ok: true, text: 'Abri.' } }));
    await expect(p).resolves.toEqual({ ok: true, text: 'Abri.' });
    ws.terminate();
  });

  it('desconectar com chamada pendente resolve na hora', async () => {
    const { registry } = await setup();
    const ws = await connect();
    const p = registry.get('desktop-mac')!.bridge.call('open_app', {});
    ws.terminate();
    await expect(p).resolves.toEqual({ ok: false, reason: 'O dispositivo desconectou.' });
    await tick();
    expect(registry.count()).toBe(0);
  });

  it('reconexão com mesmo clientId substitui a antiga e retoma o contexto', async () => {
    const { createSession, sessions } = await setup();
    const ws1 = await connect();
    ws1.send(JSON.stringify({ type: 'voice_start' }));
    await tick();
    sessions[0].detach.mockReturnValue({ resumptionHandle: 'h' });
    const code1 = closed(ws1);
    const ws2 = await connect();
    expect(await code1).toBe(1000);
    ws2.send(JSON.stringify({ type: 'voice_start' }));
    await tick();
    expect(createSession).toHaveBeenCalledTimes(2);
    expect(createSession.mock.calls[1][1]).toEqual({ resumptionHandle: 'h' });
    ws2.terminate();
  });

  it('voice_text sem sessão responde voice_not_ready', async () => {
    await setup();
    const ws = await connect();
    const msg = next(ws);
    ws.send(JSON.stringify({ type: 'voice_text', text: 'oi' }));
    expect(await msg).toMatchObject({ type: 'error', code: 'voice_not_ready' });
    ws.terminate();
  });

  it('explain_clickup_task manda instrução interna saneada', async () => {
    const { sessions } = await setup();
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'voice_start' }));
    await tick();
    ws.send(JSON.stringify({ type: 'explain_clickup_task', taskId: 'DEV-12"; drop' }));
    await tick();
    expect(sessions[0].sendInternal).toHaveBeenCalledWith(expect.stringContaining('taskId="DEV-12drop"'));
    ws.terminate();
  });
});
