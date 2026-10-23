// Mouse e teclado da máquina local, escolhendo a implementação por plataforma.
// Linux: xdotool (X11). macOS: cliclick (brew install cliclick), que exige a
// permissão de Acessibilidade pro app que abriu o processo.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { screen, systemPreferences } from 'electron';
import * as xdotool from './input-xdotool.js';
import { toCliclickArgs } from './darwin.js';

const execFileP = promisify(execFile);
const isMac = (): boolean => process.platform === 'darwin';

export type MouseUnit = 'pixel' | 'percent';

function toPixels(x: number, y: number, unit: MouseUnit): { px: number; py: number } {
  if (unit !== 'percent') return { px: Math.round(x), py: Math.round(y) };
  // Electron `screen` é mais confiável que xdotool em multi-monitor.
  const { width, height } = screen.getPrimaryDisplay().size;
  return { px: Math.round((x / 100) * width), py: Math.round((y / 100) * height) };
}

async function hasCliclick(): Promise<boolean> {
  try {
    await execFileP('which', ['cliclick'], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

/** null quando dá pra controlar mouse/teclado; senão o motivo pro Gemini falar. */
export async function inputUnavailableReason(): Promise<string | null> {
  if (!isMac()) return null;
  if (!(await hasCliclick())) return 'cliclick não instalado (brew install cliclick).';
  if (!systemPreferences.isTrustedAccessibilityClient(false)) {
    return 'Permissão de Acessibilidade não concedida ao Pixxel (Ajustes do Sistema > Privacidade e Segurança > Acessibilidade).';
  }
  return null;
}

async function cliclick(...args: string[]): Promise<void> {
  await execFileP('cliclick', args, { timeout: 10_000 });
}

export async function moveMouse(x: number, y: number, unit: MouseUnit = 'pixel'): Promise<void> {
  const { px, py } = toPixels(x, y, unit);
  if (isMac()) await cliclick(`m:${px},${py}`);
  else await xdotool.moveMouse(px, py);
}

export async function clickMouse(button: 1 | 2 | 3 = 1): Promise<void> {
  if (isMac()) await cliclick(button === 3 ? 'rc:.' : 'c:.');
  else await xdotool.clickMouse(button);
}

export async function doubleClickMouse(): Promise<void> {
  if (isMac()) await cliclick('dc:.');
  else await xdotool.doubleClickMouse();
}

export async function typeText(text: string): Promise<void> {
  if (isMac()) await cliclick(`t:${text}`);
  else await xdotool.typeText(text);
}

export async function keyPress(combo: string): Promise<void> {
  if (isMac()) await cliclick(...toCliclickArgs(combo));
  else await xdotool.keyPress(combo);
}
