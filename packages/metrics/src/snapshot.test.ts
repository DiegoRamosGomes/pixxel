import { describe, expect, it } from 'vitest';
import { formatSnapshotForVoice } from './snapshot.js';

describe('snapshot', () => {
  it('formata snapshot para voz', () => {
    const GiB = 1024 ** 3;
    const MiB = 1024 ** 2;
    const s = {
      cpuPercent: 23,
      memUsedBytes: 6.1 * GiB,
      memTotalBytes: 16 * GiB,
      rxBytesPerSec: 1.5 * MiB,
      txBytesPerSec: 300 * 1024,
      top: { topCpu: [{ pid: 1, name: 'node', cpu: 12, mem: 3 }], topMem: [] },
    };
    expect(formatSnapshotForVoice(s, 'servidor')).toBe(
      'servidor: CPU em 23%, memória 6.1 de 16.0 GB (38%), rede recebendo 1.5 MB/s e enviando 300 KB/s. Mais CPU: node (12%).',
    );
  });

  it('sem processos omite "Mais CPU"', () => {
    const s = {
      cpuPercent: 5,
      memUsedBytes: 1024 ** 3,
      memTotalBytes: 2 * 1024 ** 3,
      rxBytesPerSec: 0,
      txBytesPerSec: 0,
      top: { topCpu: [], topMem: [] },
    };
    expect(formatSnapshotForVoice(s, 'este dispositivo')).toBe(
      'este dispositivo: CPU em 5%, memória 1.0 de 2.0 GB (50%), rede recebendo 0 KB/s e enviando 0 KB/s.',
    );
  });
});
