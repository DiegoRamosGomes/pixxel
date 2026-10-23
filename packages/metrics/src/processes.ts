// Top processos por CPU e memória via `ps`. GNU (Linux) e BSD (macOS) têm
// flags diferentes, por isso um parser por plataforma.

import { run } from './exec.js';

export type ProcessInfo = { pid: number; name: string; cpu: number; mem: number };
export type TopProcesses = { topCpu: ProcessInfo[]; topMem: ProcessInfo[] };

const num = (s: string): number => parseFloat(s.replace(',', '.'));

export function parseLinuxPs(txt: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of txt.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.,]+)\s+([\d.,]+)$/);
    if (!m) continue;
    out.push({ pid: parseInt(m[1], 10), name: m[2], cpu: num(m[3]), mem: num(m[4]) });
  }
  return out;
}

export function parseDarwinPs(txt: string): ProcessInfo[] {
  const out: ProcessInfo[] = [];
  for (const line of txt.split('\n')) {
    // Colunas: PID %CPU %MEM COMM — COMM vem por último e pode ter espaços.
    const m = line.trim().match(/^(\d+)\s+([\d.,]+)\s+([\d.,]+)\s+(.+)$/);
    if (!m) continue;
    out.push({ pid: parseInt(m[1], 10), name: m[4], cpu: num(m[2]), mem: num(m[3]) });
  }
  return out;
}

async function readAll(): Promise<ProcessInfo[]> {
  if (process.platform === 'darwin') {
    return parseDarwinPs(await run('ps', ['-Aceo', 'pid,pcpu,pmem,comm']));
  }
  return parseLinuxPs(await run('ps', ['-eo', 'pid,comm,%cpu,%mem', '--no-headers', 'ww']));
}

export async function readTopProcesses(limit = 3): Promise<TopProcesses> {
  try {
    const all = await readAll();
    return {
      topCpu: [...all].sort((a, b) => b.cpu - a.cpu).slice(0, limit),
      topMem: [...all].sort((a, b) => b.mem - a.mem).slice(0, limit),
    };
  } catch (err) {
    console.warn('[top-procs] error:', err);
    return { topCpu: [], topMem: [] };
  }
}
