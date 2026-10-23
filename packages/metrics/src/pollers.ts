// Pollers de longa duração pra barra lateral do desktop. Cada um devolve a
// função de cancelamento (chamada no shutdown).

import { createCpuSampler } from './cpu.js';
import { readMemory } from './memory.js';
import { createNetworkSampler } from './network.js';
import { readTopProcesses, type TopProcesses } from './processes.js';

export type SystemMetrics = { cpuPercent: number; memUsedBytes: number; memTotalBytes: number };
export type NetworkSample = { rxBytesPerSec: number; txBytesPerSec: number };

const METRICS_POLL_MS = 5000;
const TOP_PROCS_POLL_MS = 8000;
const NETWORK_POLL_MS = 5000;

function every(intervalMs: number, tick: () => Promise<void>): () => void {
  let cancelled = false;
  const run = (): void => {
    if (!cancelled) void tick();
  };
  run();
  const id = setInterval(run, intervalMs);
  return () => {
    cancelled = true;
    clearInterval(id);
  };
}

export function startSystemMetrics(onSample: (m: SystemMetrics) => void): () => void {
  const cpu = createCpuSampler();
  return every(METRICS_POLL_MS, async () => {
    try {
      const pct = cpu();
      const mem = await readMemory();
      onSample({
        cpuPercent: Math.round(pct * 10) / 10,
        memUsedBytes: mem.usedBytes,
        memTotalBytes: mem.totalBytes,
      });
    } catch (err) {
      console.warn('[sysmetrics] tick error:', err);
    }
  });
}

export function startTopProcesses(onSample: (s: TopProcesses) => void): () => void {
  return every(TOP_PROCS_POLL_MS, async () => {
    onSample(await readTopProcesses());
  });
}

export function startNetworkPoll(onSample: (s: NetworkSample) => void): () => void {
  const sample = createNetworkSampler();
  let first = true;
  return every(NETWORK_POLL_MS, async () => {
    try {
      const s = await sample();
      // Primeira amostra só firma a base (sempre zero) — não emite.
      if (first) {
        first = false;
        return;
      }
      onSample(s);
    } catch (err) {
      console.warn('[netbw] error:', err);
    }
  });
}
