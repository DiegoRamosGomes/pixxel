import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiServerMessage } from '@assistant/shared';
import { LocalBridge } from './local-bridge.js';

type Call = Extract<ApiServerMessage, { type: 'local_tool_call' }>;

describe('LocalBridge', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolve a chamada com o resultado do cliente', async () => {
    const sent: Call[] = [];
    const b = new LocalBridge((m) => sent.push(m), 15000);
    const p = b.call('open_app', { name: 'spotify' });
    b.resolve(sent[0].callId, { ok: true, text: 'Aberto.' });
    await expect(p).resolves.toEqual({ ok: true, text: 'Aberto.' });
    expect(sent[0]).toMatchObject({ type: 'local_tool_call', name: 'open_app', args: { name: 'spotify' } });
  });

  it('timeout vira ok:false sem rejeitar', async () => {
    vi.useFakeTimers();
    const b = new LocalBridge(() => {}, 15000);
    const p = b.call('open_app', {});
    vi.advanceTimersByTime(15000);
    await expect(p).resolves.toEqual({ ok: false, reason: 'O dispositivo não respondeu a tempo.' });
  });

  it('rejectAll resolve pendentes na hora', async () => {
    const b = new LocalBridge(() => {}, 15000);
    const p = b.call('camera_frame', {});
    b.rejectAll('O dispositivo desconectou.');
    await expect(p).resolves.toEqual({ ok: false, reason: 'O dispositivo desconectou.' });
  });

  it('callId desconhecido é ignorado', () => {
    const b = new LocalBridge(() => {}, 15000);
    expect(() => b.resolve('nada', { ok: true })).not.toThrow();
  });

  it('falha ao enviar resolve com ok:false', async () => {
    const b = new LocalBridge(() => {
      throw new Error('socket fechado');
    }, 15000);
    await expect(b.call('open_app', {})).resolves.toEqual({ ok: false, reason: 'O dispositivo desconectou.' });
  });
});
