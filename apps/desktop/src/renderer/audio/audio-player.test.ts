import { describe, expect, it } from 'vitest';
import { PcmStreamPlayer } from './audio-player.js';

// AudioContext falso: só o que o player usa.
function fakeContext() {
  const sources: Array<{ started: number[]; stopped: number; onended: (() => void) | null }> = [];
  const ctx = {
    currentTime: 0,
    state: 'running',
    destination: {},
    createBuffer: (_ch: number, length: number, rate: number) => ({
      duration: length / rate,
      copyToChannel: () => {},
    }),
    createBufferSource: () => {
      const src = {
        buffer: null as unknown,
        started: [] as number[],
        stopped: 0,
        onended: null as (() => void) | null,
        connect: () => {},
        start(at: number) {
          this.started.push(at);
        },
        stop() {
          this.stopped++;
        },
      };
      sources.push(src);
      return src;
    },
    close: async () => {},
  };
  return { ctx, sources };
}

const halfSecond = () => new Int16Array(12000).buffer; // 0,5 s a 24 kHz

describe('PcmStreamPlayer', () => {
  it('backlogMs soma a fila e stopAll para as fontes e zera', () => {
    const { ctx, sources } = fakeContext();
    const player = new PcmStreamPlayer(24000, () => ctx as unknown as AudioContext);
    player.enqueue(halfSecond());
    player.enqueue(halfSecond());
    expect(player.backlogMs()).toBe(1000);
    player.stopAll();
    expect(sources.map((s) => s.stopped)).toEqual([1, 1]);
    expect(player.backlogMs()).toBe(0);
  });

  it('fonte que terminou sai da lista e não recebe stop', () => {
    const { ctx, sources } = fakeContext();
    const player = new PcmStreamPlayer(24000, () => ctx as unknown as AudioContext);
    player.enqueue(halfSecond());
    player.enqueue(halfSecond());
    sources[0].onended?.();
    player.stopAll();
    expect(sources.map((s) => s.stopped)).toEqual([0, 1]);
  });

  it('backlogMs soma a latência de saída', () => {
    const { ctx } = fakeContext();
    const player = new PcmStreamPlayer(24000, () => Object.assign(ctx, { outputLatency: 0.2 }) as unknown as AudioContext);
    player.enqueue(halfSecond());
    expect(player.backlogMs()).toBe(700);
  });

  it('backlogMs é 0 sem contexto', () => {
    expect(new PcmStreamPlayer(24000).backlogMs()).toBe(0);
  });
});
