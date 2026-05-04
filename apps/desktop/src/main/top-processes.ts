// Top processos por CPU e memória. Linux-only (shell out pra `ps`).
//
// Single `ps` por tick — top 3 por cada métrica selecionados em JS.
// Polling lento (4s) já que parsing é leve mas spawnar processo tem custo.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const POLL_MS = 8000;

export type ProcessInfo = {
  pid: number;
  name: string;
  cpu: number; // %
  mem: number; // %
};

export type TopProcesses = {
  topCpu: ProcessInfo[];
  topMem: ProcessInfo[];
};

async function readAll(): Promise<ProcessInfo[]> {
  // `comm` é o nome curto do executável (até 15 chars). Sem args, sem path.
  // --no-headers pra não precisar pular linha. ww desabilita truncate.
  const { stdout } = await execAsync('ps -eo pid,comm,%cpu,%mem --no-headers ww', {
    maxBuffer: 4 * 1024 * 1024,
  });
  const out: ProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)$/);
    if (!m) continue;
    out.push({
      pid: parseInt(m[1], 10),
      name: m[2],
      cpu: parseFloat(m[3]),
      mem: parseFloat(m[4]),
    });
  }
  return out;
}

export async function readTopProcesses(): Promise<TopProcesses> {
  try {
    const all = await readAll();
    const topCpu = [...all].sort((a, b) => b.cpu - a.cpu).slice(0, 3);
    const topMem = [...all].sort((a, b) => b.mem - a.mem).slice(0, 3);
    return { topCpu, topMem };
  } catch (err) {
    console.warn('[top-procs] error:', err);
    return { topCpu: [], topMem: [] };
  }
}

export function startTopProcesses(
  onSample: (s: TopProcesses) => void,
): () => void {
  let cancelled = false;

  async function tick(): Promise<void> {
    if (cancelled) return;
    const r = await readTopProcesses();
    onSample(r);
  }

  void tick();
  const id = setInterval(() => void tick(), POLL_MS);
  return () => {
    cancelled = true;
    clearInterval(id);
  };
}
