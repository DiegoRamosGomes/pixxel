// CPU: os.cpus() é cumulativo, então o percentual sai do diff entre amostras
// consecutivas. A primeira amostra de cada sampler devolve 0.

import os from 'node:os';

export function createCpuSampler(): () => number {
  let prev: { idle: number; total: number } | null = null;
  return () => {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    if (!prev) {
      prev = { idle, total };
      return 0;
    }
    const idleDelta = idle - prev.idle;
    const totalDelta = total - prev.total;
    prev = { idle, total };
    if (totalDelta <= 0) return 0;
    const pct = ((totalDelta - idleDelta) / totalDelta) * 100;
    return Math.max(0, Math.min(100, pct));
  };
}
