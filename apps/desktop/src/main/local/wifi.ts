// Info da rede WiFi conectada (SSID + força do sinal). Linux via nmcli; macOS via networksetup/ipconfig.
// Polling lento (30s) — rede raramente muda.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { parseIpconfigSsid, parseWifiDevice } from './darwin.js';

const execAsync = promisify(exec);
const POLL_MS = 30_000;

export type WifiInfo = {
  ssid: string | null;
  signal: number | null; // 0-100
};

async function readWifiLinux(): Promise<WifiInfo> {
  try {
    // LANG=C força output em inglês (active vira `yes`/`no`). Sem isso, em
    // sistemas pt-BR vem `sim`/`não` e o parse quebra.
    // -t = terse (separado por `:`), -f = fields.
    const { stdout } = await execAsync(
      'nmcli -t -f active,ssid,signal dev wifi',
      { timeout: 3000, env: { ...process.env, LANG: 'C', LC_ALL: 'C' } },
    );
    for (const line of stdout.split('\n')) {
      // Formato: active:ssid:signal — anchor :(\d+)$ pra força (último campo).
      const m = line.match(/^(yes|no):(.+):(\d+)$/);
      if (m && m[1] === 'yes') {
        return {
          ssid: m[2].replace(/\\:/g, ':'),
          signal: parseInt(m[3], 10),
        };
      }
    }
    return { ssid: null, signal: null };
  } catch {
    // nmcli não instalado ou sem permissão
    return { ssid: null, signal: null };
  }
}

export type WifiRestartResult =
  | { ok: true; ssid: string | null; signal: number | null; connected?: boolean }
  | { ok: false; reason: string };

// ===== macOS =====
// SSID vem de `ipconfig getsummary` — sem permissão de localização o macOS
// devolve `<redacted>`, aí fica null. Força do sinal não é exposta: null.

async function wifiDevice(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('networksetup -listallhardwareports', { timeout: 3000 });
    return parseWifiDevice(stdout);
  } catch {
    return null;
  }
}

async function readWifiDarwin(): Promise<WifiInfo> {
  const dev = await wifiDevice();
  if (!dev) return { ssid: null, signal: null };
  try {
    const { stdout } = await execAsync(`ipconfig getsummary ${dev}`, { timeout: 3000 });
    return { ssid: parseIpconfigSsid(stdout), signal: null };
  } catch {
    return { ssid: null, signal: null };
  }
}

async function hasIp(dev: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(`ipconfig getifaddr ${dev}`, { timeout: 3000 });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

async function restartWifiDarwin(): Promise<WifiRestartResult> {
  const dev = await wifiDevice();
  if (!dev) return { ok: false, reason: 'não achei a interface Wi-Fi' };
  try {
    await execAsync(`networksetup -setairportpower ${dev} off`, { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 2000));
    await execAsync(`networksetup -setairportpower ${dev} on`, { timeout: 5000 });
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'networksetup falhou' };
  }
  // Aguarda pegar IP de novo (até 15s).
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await hasIp(dev)) {
      const w = await readWifiDarwin();
      return { ok: true, ssid: w.ssid, signal: null, connected: true };
    }
  }
  return { ok: true, ssid: null, signal: null, connected: false };
}

function readWifi(): Promise<WifiInfo> {
  return process.platform === 'darwin' ? readWifiDarwin() : readWifiLinux();
}

// Reinicia o rádio WiFi via nmcli (off → on). Não precisa sudo no Ubuntu padrão
// quando NetworkManager está rodando como serviço do sistema.
export async function restartWifi(): Promise<WifiRestartResult> {
  if (process.platform === 'darwin') return restartWifiDarwin();
  try {
    await execAsync('nmcli radio wifi off', { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 2000));
    await execAsync('nmcli radio wifi on', { timeout: 5000 });
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'nmcli falhou',
    };
  }

  // Aguarda reconexão e relê estado (até 15s).
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const w = await readWifi();
    if (w.ssid) return { ok: true, ssid: w.ssid, signal: w.signal };
  }
  return { ok: true, ssid: null, signal: null };
}

export function startWifiPoll(
  onSample: (w: WifiInfo) => void,
): () => void {
  let cancelled = false;
  let tickCount = 0;

  async function tick(): Promise<void> {
    if (cancelled) return;
    const w = await readWifi();
    tickCount += 1;
    if (tickCount === 1 || tickCount % 10 === 0) {
      console.log(`[wifi] tick #${tickCount}: ${w.ssid ?? '—'} signal=${w.signal ?? '—'}`);
    }
    onSample(w);
  }

  console.log(`[wifi] iniciado (poll ${POLL_MS}ms)`);
  void tick();
  const id = setInterval(() => void tick(), POLL_MS);
  return () => {
    cancelled = true;
    clearInterval(id);
  };
}
