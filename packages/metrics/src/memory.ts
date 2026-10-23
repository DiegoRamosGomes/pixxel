// Memória usada/total. Linux: /proc/meminfo (MemAvailable desconta cache,
// mais fiel que os.freemem). macOS: vm_stat (free + inactive + speculative +
// purgeable são recuperáveis).

import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { run } from './exec.js';

export function parseLinuxMeminfo(
  txt: string,
): { totalBytes: number; availableBytes: number } | null {
  const get = (key: string): number | null => {
    const m = txt.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
    return m ? parseInt(m[1], 10) * 1024 : null;
  };
  const total = get('MemTotal');
  const available = get('MemAvailable');
  if (total == null || available == null) return null;
  return { totalBytes: total, availableBytes: available };
}

export function parseDarwinVmStat(txt: string): { availableBytes: number } | null {
  const page = txt.match(/page size of (\d+) bytes/);
  if (!page) return null;
  const pageSize = parseInt(page[1], 10);
  const get = (label: string): number => {
    const m = txt.match(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.`, 'm'));
    return m ? parseInt(m[1], 10) : 0;
  };
  const pages = get('free') + get('inactive') + get('speculative') + get('purgeable');
  return { availableBytes: pages * pageSize };
}

export async function readMemory(): Promise<{ usedBytes: number; totalBytes: number }> {
  try {
    if (process.platform === 'linux') {
      const m = parseLinuxMeminfo(await readFile('/proc/meminfo', 'utf8'));
      if (m) return { usedBytes: m.totalBytes - m.availableBytes, totalBytes: m.totalBytes };
    } else if (process.platform === 'darwin') {
      const m = parseDarwinVmStat(await run('vm_stat', []));
      const total = os.totalmem();
      if (m) return { usedBytes: Math.max(0, total - m.availableBytes), totalBytes: total };
    }
  } catch {
    // cai no fallback
  }
  return { usedBytes: os.totalmem() - os.freemem(), totalBytes: os.totalmem() };
}
