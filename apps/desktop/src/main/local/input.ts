// Mouse e teclado da máquina local, escolhendo a implementação por plataforma.
// Linux: xdotool (X11).

import { screen } from 'electron';
import * as xdotool from './input-xdotool.js';

export type MouseUnit = 'pixel' | 'percent';

function toPixels(x: number, y: number, unit: MouseUnit): { px: number; py: number } {
  if (unit !== 'percent') return { px: Math.round(x), py: Math.round(y) };
  // Electron `screen` é mais confiável que xdotool em multi-monitor.
  const { width, height } = screen.getPrimaryDisplay().size;
  return { px: Math.round((x / 100) * width), py: Math.round((y / 100) * height) };
}

export async function inputBackendAvailable(): Promise<boolean> {
  return process.platform === 'linux';
}

export async function moveMouse(x: number, y: number, unit: MouseUnit = 'pixel'): Promise<void> {
  const { px, py } = toPixels(x, y, unit);
  await xdotool.moveMouse(px, py);
}

export async function clickMouse(button: 1 | 2 | 3 = 1): Promise<void> {
  await xdotool.clickMouse(button);
}

export async function doubleClickMouse(): Promise<void> {
  await xdotool.doubleClickMouse();
}

export async function typeText(text: string): Promise<void> {
  await xdotool.typeText(text);
}

export async function keyPress(combo: string): Promise<void> {
  await xdotool.keyPress(combo);
}
