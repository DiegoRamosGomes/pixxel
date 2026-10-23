import { describe, expect, it, vi } from 'vitest';
import { ClientRegistry, type ConnectedClient, type VoiceSessionHandle } from './client-registry.js';
import { LocalBridge } from './local-bridge.js';

function session(ready: boolean): VoiceSessionHandle {
  return {
    start: vi.fn(() => ({ ok: true })),
    stop: vi.fn(),
    detach: vi.fn(() => null),
    sendAudio: vi.fn(),
    endTurn: vi.fn(),
    sendText: vi.fn(() => true),
    sendInternal: vi.fn(() => true),
    isReady: () => ready,
  };
}

function client(id: string, over: Partial<ConnectedClient> = {}): ConnectedClient {
  return {
    clientId: id,
    kind: 'desktop',
    localOps: [],
    send: vi.fn(),
    sendAudio: vi.fn(),
    close: vi.fn(),
    bridge: new LocalBridge(() => {}, 1000),
    session: null,
    lastInteractionAt: 0,
    connectedAt: 0,
    ...over,
  };
}

describe('ClientRegistry', () => {
  it('pickSpeaker escolhe o cliente pronto com interação mais recente', () => {
    const r = new ClientRegistry();
    r.add(client('a', { session: session(true), lastInteractionAt: 10 }));
    r.add(client('b', { session: session(true), lastInteractionAt: 20 }));
    r.add(client('c', { session: session(false), lastInteractionAt: 30 }));
    expect(r.pickSpeaker()?.clientId).toBe('b');
  });

  it('pickSpeaker desempata pelo mais recente a conectar', () => {
    const r = new ClientRegistry();
    r.add(client('a', { session: session(true), connectedAt: 1 }));
    r.add(client('b', { session: session(true), connectedAt: 2 }));
    expect(r.pickSpeaker()?.clientId).toBe('b');
  });

  it('pickSpeaker sem cliente pronto devolve null', () => {
    const r = new ClientRegistry();
    r.add(client('a'));
    expect(r.pickSpeaker()).toBeNull();
  });

  it('add devolve o anterior com mesmo clientId', () => {
    const r = new ClientRegistry();
    const a1 = client('a');
    const a2 = client('a');
    r.add(a1);
    expect(r.add(a2)).toBe(a1);
    expect(r.get('a')).toBe(a2);
    expect(r.count()).toBe(1);
  });

  it('remove com cliente antigo não apaga o novo', () => {
    const r = new ClientRegistry();
    const a1 = client('a');
    const a2 = client('a');
    r.add(a1);
    r.add(a2);
    r.remove('a', a1);
    expect(r.get('a')).toBe(a2);
  });

  it('touch atualiza a última interação', () => {
    const r = new ClientRegistry();
    r.add(client('a'));
    r.touch('a');
    expect(r.get('a')!.lastInteractionAt).toBeGreaterThan(0);
  });

  it('contexto de retomada vence depois de 15 minutos', () => {
    vi.useFakeTimers();
    try {
      const r = new ClientRegistry();
      r.saveRecovery('a', { resumptionHandle: 'h' });
      vi.advanceTimersByTime(15 * 60_000 + 1);
      expect(r.takeRecovery('a')).toBeUndefined();
      r.saveRecovery('b', { resumptionHandle: 'h2' });
      vi.advanceTimersByTime(14 * 60_000);
      expect(r.takeRecovery('b')).toEqual({ resumptionHandle: 'h2' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('takeRecovery consome o contexto', () => {
    const r = new ClientRegistry();
    r.saveRecovery('a', { resumptionHandle: 'h' });
    expect(r.takeRecovery('a')).toEqual({ resumptionHandle: 'h' });
    expect(r.takeRecovery('a')).toBeUndefined();
  });
});
