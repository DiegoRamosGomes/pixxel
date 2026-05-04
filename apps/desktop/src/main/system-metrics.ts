// Métricas do sistema pro sidebar (CPU + memória, por enquanto).
//
// CPU: os.cpus() é cumulativo, então diff entre samples consecutivos.
// Memória: /proc/meminfo pra MemAvailable (subtrai cache, mais preciso que
// os.freemem que ignora cache).

import os from 'node:os';
import { readFile } from 'node:fs/promises';

export type SystemMetrics = {
  cpuPercent: number; // 0-100, média das cores
  memUsedBytes: number;
  memTotalBytes: number;
};

let prevCpu: { idle: number; total: number } | null = null;

function sampleCpu(): number {
  const cpus = os.cpus();
  let totalIdle = 0;
  let totalAll = 0;
  for (const c of cpus) {
    totalIdle += c.times.idle;
    totalAll +=
      c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
  }
  if (!prevCpu) {
    prevCpu = { idle: totalIdle, total: totalAll };
    return 0;
  }
  const idleDelta = totalIdle - prevCpu.idle;
  const totalDelta = totalAll - prevCpu.total;
  prevCpu = { idle: totalIdle, total: totalAll };
  if (totalDelta <= 0) return 0;
  const pct = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.max(0, Math.min(100, pct));
}

async function readMemInfo(): Promise<{ total: number; available: number }> {
  try {
    const txt = await readFile('/proc/meminfo', 'utf8');
    const get = (key: string): number => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
      return m ? parseInt(m[1], 10) * 1024 : 0;
    };
    return { total: get('MemTotal'), available: get('MemAvailable') };
  } catch {
    // Fallback se não for Linux ou /proc bloqueado
    return { total: os.totalmem(), available: os.freemem() };
  }
}

const POLL_MS = 5000;

export function startSystemMetrics(
  onSample: (m: SystemMetrics) => void,
): () => void {
  let cancelled = false;

  async function tick(): Promise<void> {
    if (cancelled) return;
    try {
      const cpu = sampleCpu();
      const mem = await readMemInfo();
      onSample({
        cpuPercent: Math.round(cpu * 10) / 10,
        memUsedBytes: mem.total - mem.available,
        memTotalBytes: mem.total,
      });
    } catch (err) {
      console.warn('[sysmetrics] tick error:', err);
    }
  }

  // Primeiro sample pra firmar prevCpu (resultado é 0 nesse, descartado).
  void tick();
  const id = setInterval(() => void tick(), POLL_MS);
  return () => {
    cancelled = true;
    clearInterval(id);
  };
}
