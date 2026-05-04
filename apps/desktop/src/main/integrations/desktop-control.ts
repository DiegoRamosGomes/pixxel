// Wrapper de mouse/teclado via xdotool (X11). Cada função spawna um processo
// curto — overhead ~5-15ms por chamada, irrelevante pra cenário humano.
//
// CUIDADO: essas funções têm efeito real no desktop do usuário. Sempre
// rastrear via abort flag (`isAborted()`) e parar imediatamente quando setado.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execP = promisify(exec);

let aborted = false;

export function abortDemo(): void {
  aborted = true;
}

export function resetAbort(): void {
  aborted = false;
}

export function isAborted(): boolean {
  return aborted;
}

async function run(cmd: string): Promise<{ stdout: string; stderr: string }> {
  return execP(cmd, { timeout: 5000 });
}

export type ScreenSize = { width: number; height: number };

let cachedSize: ScreenSize | null = null;

export async function getScreenSize(): Promise<ScreenSize> {
  if (cachedSize) return cachedSize;
  // xdotool getdisplaygeometry → "1920 1080"
  const { stdout } = await run('xdotool getdisplaygeometry');
  const [w, h] = stdout.trim().split(/\s+/).map(Number);
  cachedSize = { width: w || 1920, height: h || 1080 };
  return cachedSize;
}

export type MouseUnit = 'pixel' | 'percent';

/** Move o cursor pra (x,y). Se unit=percent, x/y são 0..100. */
export async function moveMouse(
  x: number,
  y: number,
  unit: MouseUnit = 'pixel',
): Promise<void> {
  if (aborted) return;
  let px = x, py = y;
  if (unit === 'percent') {
    const s = await getScreenSize();
    px = Math.round((x / 100) * s.width);
    py = Math.round((y / 100) * s.height);
  }
  await run(`xdotool mousemove ${Math.round(px)} ${Math.round(py)}`);
}

/** Clica botão (1=esq, 2=meio, 3=dir). Default esquerdo. */
export async function clickMouse(button: 1 | 2 | 3 = 1): Promise<void> {
  if (aborted) return;
  await run(`xdotool click ${button}`);
}

export async function doubleClickMouse(): Promise<void> {
  if (aborted) return;
  await run(`xdotool click --repeat 2 --delay 100 1`);
}

/** Digita texto literal (escapa aspas pra shell). */
export async function typeText(text: string, delayMs = 30): Promise<void> {
  if (aborted) return;
  // Escapa aspas simples pro shell.
  const safe = text.replace(/'/g, "'\\''");
  await run(`xdotool type --delay ${delayMs} -- '${safe}'`);
}

/**
 * Envia combinação de teclas. Aceita formato xdotool: "Return", "Escape",
 * "ctrl+c", "alt+Tab", "super+l". Veja `xdotool key --help` pra lista.
 */
export async function keyPress(combo: string): Promise<void> {
  if (aborted) return;
  const safe = combo.replace(/[^a-zA-Z0-9+_\-]/g, '');
  if (!safe) throw new Error(`combo inválido: ${combo}`);
  await run(`xdotool key ${safe}`);
}

/** Sleep abortável — checa flag a cada 100ms. */
export async function sleep(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (aborted) return;
    await new Promise((r) => setTimeout(r, Math.min(100, deadline - Date.now())));
  }
}
