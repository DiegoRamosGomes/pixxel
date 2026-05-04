// Banda de rede: lê /proc/net/dev e diffia entre samples pra ter bytes/s
// up e down. Soma todas interfaces "reais" (filtra lo, docker*, br-*, veth*).
//
// Polling 1.5s — alinha com o sparkline da CPU pra timeline consistente.

import { readFile } from 'node:fs/promises';

export type NetworkSample = {
  rxBytesPerSec: number;
  txBytesPerSec: number;
};

const POLL_MS = 5000;

function isVirtualIface(name: string): boolean {
  return (
    name === 'lo' ||
    name.startsWith('docker') ||
    name.startsWith('br-') ||
    name.startsWith('veth') ||
    name.startsWith('virbr')
  );
}

async function readNetDev(): Promise<{ rx: number; tx: number }> {
  const txt = await readFile('/proc/net/dev', 'utf8');
  let totalRx = 0;
  let totalTx = 0;
  for (const raw of txt.split('\n')) {
    // Formato: "  eth0: rxBytes rxPackets ... txBytes txPackets ..."
    // Colunas: rx[0..7] tx[8..15]. Bytes na 0 e 8.
    const m = raw.match(/^\s*([^:]+):\s+(.+)$/);
    if (!m) continue;
    const iface = m[1].trim();
    if (isVirtualIface(iface)) continue;
    const parts = m[2].trim().split(/\s+/);
    if (parts.length < 16) continue;
    totalRx += parseInt(parts[0], 10) || 0;
    totalTx += parseInt(parts[8], 10) || 0;
  }
  return { rx: totalRx, tx: totalTx };
}

let prev: { rx: number; tx: number; t: number } | null = null;

export function startNetworkPoll(
  onSample: (s: NetworkSample) => void,
): () => void {
  let cancelled = false;

  async function tick(): Promise<void> {
    if (cancelled) return;
    try {
      const now = await readNetDev();
      const t = Date.now();
      if (prev) {
        const dt = (t - prev.t) / 1000;
        if (dt > 0) {
          const rxRate = Math.max(0, (now.rx - prev.rx) / dt);
          const txRate = Math.max(0, (now.tx - prev.tx) / dt);
          onSample({ rxBytesPerSec: rxRate, txBytesPerSec: txRate });
        }
      }
      prev = { rx: now.rx, tx: now.tx, t };
    } catch (err) {
      console.warn('[netbw] error:', err);
    }
  }

  void tick();
  const id = setInterval(() => void tick(), POLL_MS);
  return () => {
    cancelled = true;
    clearInterval(id);
  };
}

