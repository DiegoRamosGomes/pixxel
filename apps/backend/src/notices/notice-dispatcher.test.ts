import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectedClient } from '../clients/client-registry.js';
import type { WebhookEventRow } from '../memory/db.js';
import { NoticeDispatcher } from './notice-dispatcher.js';
import { clickupNotice, emailNotice } from './notices.js';

type FakeClient = ConnectedClient & { spoke: string[] };

function fakeClient(id: string, ready: boolean, lastInteractionAt = 0): FakeClient {
  const spoke: string[] = [];
  return {
    clientId: id,
    kind: 'desktop',
    localOps: [],
    send: vi.fn(),
    sendAudio: vi.fn(),
    close: vi.fn(),
    bridge: {} as never,
    session: {
      start: vi.fn(() => ({ ok: true })),
      stop: vi.fn(),
      detach: vi.fn(() => null),
      sendAudio: vi.fn(),
      endTurn: vi.fn(),
      sendText: vi.fn(() => true),
      sendInternal: vi.fn((t: string) => {
        spoke.push(t);
        return true;
      }),
      isReady: () => ready,
    },
    lastInteractionAt,
    connectedAt: 0,
    spoke,
  };
}

function registry(clients: FakeClient[]) {
  return {
    all: () => clients,
    count: () => clients.length,
    pickSpeaker: () => {
      const ready = clients.filter((c) => c.session?.isReady());
      ready.sort((a, b) => b.lastInteractionAt - a.lastInteractionAt);
      return ready[0] ?? null;
    },
  };
}

const email = {
  id: 'e1',
  uid: 1,
  from: 'Fulano <f@x.com>',
  subject: 'Contrato',
  snippet: '',
  date: null,
  important: true,
  source: 'rule',
  processedAt: '2026-10-22T00:00:00.000Z',
};

function row(id: string, kind = 'expo.build.finished'): WebhookEventRow {
  return {
    id,
    provider: 'expo',
    event_kind: kind,
    payload: JSON.stringify({ status: 'finished', appName: 'meu-app', platform: 'ios' }),
    received_at: 1,
    delivered_at: null,
    retry_count: 0,
  };
}

describe('NoticeDispatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('e-mail fala no falante e manda push mesmo com app aberto', () => {
    const a = fakeClient('a', true);
    const sendPush = vi.fn(async () => {});
    const d = new NoticeDispatcher({ registry: registry([a]), sendPush, markExpoDelivered: vi.fn() });
    d.dispatch(emailNotice([email]));
    expect(a.spoke).toHaveLength(1);
    expect(a.spoke[0]).toContain('Fulano');
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(sendPush).toHaveBeenCalledWith(expect.objectContaining({ priority: 'high' }));
  });

  it('clickup: widget para todos, push só sem clientes', () => {
    const a = fakeClient('a', true);
    const b = fakeClient('b', false);
    const sendPush = vi.fn(async () => {});
    const batch = { items: [], summary: '2 menções novas' };
    new NoticeDispatcher({ registry: registry([a, b]), sendPush, markExpoDelivered: vi.fn() }).dispatch(
      clickupNotice(batch),
    );
    expect(a.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'widget', ttlMs: 30 * 60_000 }));
    expect(b.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'widget' }));
    expect(sendPush).not.toHaveBeenCalled();

    new NoticeDispatcher({ registry: registry([]), sendPush, markExpoDelivered: vi.fn() }).dispatch(
      clickupNotice(batch),
    );
    expect(sendPush).toHaveBeenCalledTimes(1);
  });

  it('dois clientes prontos: só o escolhido fala', () => {
    const a = fakeClient('a', true, 10);
    const b = fakeClient('b', true, 20);
    new NoticeDispatcher({ registry: registry([a, b]), sendPush: vi.fn(async () => {}), markExpoDelivered: vi.fn() }).dispatch(
      emailNotice([email]),
    );
    expect(a.spoke).toHaveLength(0);
    expect(b.spoke).toHaveLength(1);
  });

  it('expo sem ninguém: push uma vez, fala depois uma vez e marca entregue', async () => {
    const clients: FakeClient[] = [];
    const sendPush = vi.fn(async () => {});
    const markExpoDelivered = vi.fn();
    const d = new NoticeDispatcher({ registry: registry(clients), sendPush, markExpoDelivered });
    d.enqueueExpo(row('e1'));
    expect(sendPush).toHaveBeenCalledTimes(1);
    expect(markExpoDelivered).not.toHaveBeenCalled();

    const a = fakeClient('a', true);
    clients.push(a);
    d.onSessionReady();
    await vi.advanceTimersByTimeAsync(500);
    expect(a.spoke).toHaveLength(1);
    expect(a.spoke[0]).toContain('meu-app');
    expect(a.send).not.toHaveBeenCalled();
    expect(markExpoDelivered).toHaveBeenCalledWith('e1');

    const b = fakeClient('b', true);
    clients.push(b);
    d.onSessionReady();
    await vi.advanceTimersByTimeAsync(500);
    expect(a.spoke).toHaveLength(1);
    expect(b.spoke).toHaveLength(0);
    expect(markExpoDelivered).toHaveBeenCalledTimes(1);
  });

  it('expo com cliente conectado mostra widget e não manda push', () => {
    const a = fakeClient('a', true);
    const sendPush = vi.fn(async () => {});
    const d = new NoticeDispatcher({ registry: registry([a]), sendPush, markExpoDelivered: vi.fn() });
    d.enqueueExpo(row('e1'));
    expect(a.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'widget' }));
    expect(a.spoke).toHaveLength(1);
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('expo vindo do boot não gera push', () => {
    const sendPush = vi.fn(async () => {});
    new NoticeDispatcher({ registry: registry([]), sendPush, markExpoDelivered: vi.fn() }).enqueueExpo(row('e1'), {
      fromBoot: true,
    });
    expect(sendPush).not.toHaveBeenCalled();
  });

  it('várias frases de build viram uma fala agregada', async () => {
    const clients: FakeClient[] = [];
    const d = new NoticeDispatcher({
      registry: registry(clients),
      sendPush: vi.fn(async () => {}),
      markExpoDelivered: vi.fn(),
    });
    d.enqueueExpo(row('e1', 'expo.build.started'));
    d.enqueueExpo(row('e2', 'expo.build.finished'));
    const a = fakeClient('a', true);
    clients.push(a);
    d.onSessionReady();
    await vi.advanceTimersByTimeAsync(500);
    expect(a.spoke).toHaveLength(1);
    expect(a.spoke[0]).toContain('Tem 2 novidades de build acumuladas');
  });
});
