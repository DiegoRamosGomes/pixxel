// Foto do estado do hardware pra responder "como está o servidor/dispositivo".

import { createCpuSampler } from './cpu.js';
import { readMemory } from './memory.js';
import { createNetworkSampler } from './network.js';
import { readTopProcesses, type TopProcesses } from './processes.js';

export type SystemSnapshot = {
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
  rxBytesPerSec: number;
  txBytesPerSec: number;
  top: TopProcesses;
};

const SAMPLE_WINDOW_MS = 1000;

export async function getSystemSnapshot(): Promise<SystemSnapshot> {
  const cpu = createCpuSampler();
  const net = createNetworkSampler();
  cpu();
  await net().catch(() => undefined);
  const [mem, top] = await Promise.all([
    readMemory(),
    readTopProcesses(),
    new Promise((r) => setTimeout(r, SAMPLE_WINDOW_MS)),
  ]);
  const cpuPercent = cpu();
  const rate = await net().catch(() => ({ rxBytesPerSec: 0, txBytesPerSec: 0 }));
  return {
    cpuPercent: Math.round(cpuPercent),
    memUsedBytes: mem.usedBytes,
    memTotalBytes: mem.totalBytes,
    rxBytesPerSec: rate.rxBytesPerSec,
    txBytesPerSec: rate.txBytesPerSec,
    top,
  };
}

function formatRate(bytesPerSec: number): string {
  const MiB = 1024 ** 2;
  if (bytesPerSec >= MiB) return `${(bytesPerSec / MiB).toFixed(1)} MB/s`;
  return `${Math.round(bytesPerSec / 1024)} KB/s`;
}

export function formatSnapshotForVoice(s: SystemSnapshot, label: string): string {
  const GiB = 1024 ** 3;
  const memPct = s.memTotalBytes > 0 ? Math.round((s.memUsedBytes / s.memTotalBytes) * 100) : 0;
  let text =
    `${label}: CPU em ${Math.round(s.cpuPercent)}%, ` +
    `memória ${(s.memUsedBytes / GiB).toFixed(1)} de ${(s.memTotalBytes / GiB).toFixed(1)} GB (${memPct}%), ` +
    `rede recebendo ${formatRate(s.rxBytesPerSec)} e enviando ${formatRate(s.txBytesPerSec)}.`;
  const top = s.top.topCpu.slice(0, 3);
  if (top.length > 0) {
    text += ` Mais CPU: ${top.map((p) => `${p.name} (${Math.round(p.cpu)}%)`).join(', ')}.`;
  }
  return text;
}
