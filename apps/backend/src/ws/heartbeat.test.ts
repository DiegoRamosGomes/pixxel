import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from '@fastify/websocket';
import { ClientRegistry } from '../clients/client-registry.js';
import { handleConnection } from './handler.js';

// Socket falso: dá pra simular um cliente que não responde ping (Mac dormindo).
class FakeSocket extends EventEmitter {
  OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  send = vi.fn((d: string) => {
    this.sent.push(d);
  });
  ping = vi.fn();
  close = vi.fn();
  terminate = vi.fn(() => {
    this.readyState = 3;
    this.emit('close', 1006, Buffer.from(''));
  });
}

const TOKEN = 'token-de-teste-123';

function setup() {
  const socket = new FakeSocket();
  const registry = new ClientRegistry();
  handleConnection(socket as unknown as WebSocket, {
    token: TOKEN,
    registry,
    localToolTimeoutMs: 60_000,
    heartbeatIntervalMs: 1000,
    createSession: vi.fn(),
    onPresentationAbort: vi.fn(),
  });
  socket.emit(
    'message',
    Buffer.from(
      JSON.stringify({
        type: 'hello',
        protocolVersion: 2,
        token: TOKEN,
        clientId: 'desktop-mac',
        clientKind: 'desktop',
        localOps: ['open_app'],
      }),
    ),
    false,
  );
  return { socket, registry };
}

describe('heartbeat do WebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cliente que não responde ping é derrubado e sai do registro', async () => {
    const { socket, registry } = setup();
    expect(registry.count()).toBe(1);
    const pending = registry.get('desktop-mac')!.bridge.call('open_app', {});
    vi.advanceTimersByTime(1000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(socket.terminate).toHaveBeenCalledTimes(1);
    expect(registry.count()).toBe(0);
    await expect(pending).resolves.toEqual({ ok: false, reason: 'O dispositivo desconectou.' });
  });

  it('cliente que responde pong continua conectado', () => {
    const { socket, registry } = setup();
    vi.advanceTimersByTime(1000);
    socket.emit('pong');
    vi.advanceTimersByTime(1000);
    socket.emit('pong');
    vi.advanceTimersByTime(1000);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(registry.count()).toBe(1);
  });
});
