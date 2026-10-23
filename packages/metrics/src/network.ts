// Banda de rede: contadores cumulativos de bytes, diffados entre amostras.
// Linux: /proc/net/dev. macOS: `netstat -ibn` (linhas <Link#>).

import { readFile } from 'node:fs/promises';
import { run } from './exec.js';

function isVirtualLinuxIface(name: string): boolean {
  return (
    name === 'lo' ||
    name.startsWith('docker') ||
    name.startsWith('br-') ||
    name.startsWith('veth') ||
    name.startsWith('virbr')
  );
}

export function parseLinuxNetDev(txt: string): { rxBytes: number; txBytes: number } {
  let rxBytes = 0;
  let txBytes = 0;
  for (const raw of txt.split('\n')) {
    // "  eth0: rxBytes rxPackets ... txBytes ..." — bytes nas colunas 0 e 8.
    const m = raw.match(/^\s*([^:|]+):\s+(.+)$/);
    if (!m) continue;
    const iface = m[1].trim();
    if (isVirtualLinuxIface(iface)) continue;
    const parts = m[2].trim().split(/\s+/);
    if (parts.length < 16) continue;
    rxBytes += parseInt(parts[0], 10) || 0;
    txBytes += parseInt(parts[8], 10) || 0;
  }
  return { rxBytes, txBytes };
}

export function parseDarwinNetstat(txt: string): { rxBytes: number; txBytes: number } {
  let rxBytes = 0;
  let txBytes = 0;
  for (const raw of txt.split('\n')) {
    const parts = raw.trim().split(/\s+/);
    if (parts.length < 10 || !parts[2]?.startsWith('<Link#')) continue;
    if (parts[0].startsWith('lo')) continue;
    // Address pode faltar (lo0, utun) — conta a partir do fim:
    // ... Ibytes Opkts Oerrs Obytes Coll
    const len = parts.length;
    rxBytes += parseInt(parts[len - 5], 10) || 0;
    txBytes += parseInt(parts[len - 2], 10) || 0;
  }
  return { rxBytes, txBytes };
}

async function readCounters(): Promise<{ rxBytes: number; txBytes: number }> {
  if (process.platform === 'darwin') return parseDarwinNetstat(await run('netstat', ['-ibn']));
  return parseLinuxNetDev(await readFile('/proc/net/dev', 'utf8'));
}

export function createNetworkSampler(): () => Promise<{ rxBytesPerSec: number; txBytesPerSec: number }> {
  let prev: { rx: number; tx: number; t: number } | null = null;
  return async () => {
    const now = await readCounters();
    const t = Date.now();
    const last = prev;
    prev = { rx: now.rxBytes, tx: now.txBytes, t };
    if (!last) return { rxBytesPerSec: 0, txBytesPerSec: 0 };
    const dt = (t - last.t) / 1000;
    if (dt <= 0) return { rxBytesPerSec: 0, txBytesPerSec: 0 };
    return {
      rxBytesPerSec: Math.max(0, (now.rxBytes - last.rx) / dt),
      txBytesPerSec: Math.max(0, (now.txBytes - last.tx) / dt),
    };
  };
}
