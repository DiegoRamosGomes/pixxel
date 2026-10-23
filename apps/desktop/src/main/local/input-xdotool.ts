// Mouse e teclado via xdotool (X11). Cada função spawna um processo; pra
// movimento contínuo (gestos) use hand-mouse.ts, que mantém um processo vivo.

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(exec);

/** Move o cursor pra (x,y) em pixels. */
export async function moveMouse(x: number, y: number): Promise<void> {
  await run(`xdotool mousemove ${Math.round(x)} ${Math.round(y)}`);
}

/** Clica botão (1=esq, 2=meio, 3=dir). Default esquerdo. */
export async function clickMouse(button: 1 | 2 | 3 = 1): Promise<void> {
  await run(`xdotool click ${button}`);
}

export async function doubleClickMouse(): Promise<void> {
  await run(`xdotool click --repeat 2 --delay 100 1`);
}

/** Digita texto literal (escapa aspas pra shell). */
export async function typeText(text: string, delayMs = 30): Promise<void> {
  const safe = text.replace(/'/g, "'\\''");
  await run(`xdotool type --delay ${delayMs} -- '${safe}'`);
}

/**
 * Envia combinação de teclas. Aceita formato xdotool: "Return", "Escape",
 * "ctrl+c", "alt+Tab", "super+l". Veja `xdotool key --help` pra lista.
 */
export async function keyPress(combo: string): Promise<void> {
  const safe = combo.replace(/[^a-zA-Z0-9+_\-]/g, '');
  if (!safe) throw new Error(`combo inválido: ${combo}`);
  await run(`xdotool key ${safe}`);
}
