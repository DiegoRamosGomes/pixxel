// Controle de mouse via xdotool em modo persistente.
//
// Diferente do desktop-control.ts (que spawna xdotool a cada comando, custo
// ~10ms por chamada), aqui mantemos UM processo `xdotool -` vivo e mandamos
// comandos via stdin. Necessário pra hand-tracking em 15-30 fps, onde
// spawnar a cada frame estouraria CPU.
//
// Comandos suportados pelo xdotool stdin: "mousemove X Y", "click N", etc.
// Veja `man xdotool` (seção "MULTIPLE COMMANDS").

import { spawn, type ChildProcessWithoutNullStreams, exec } from 'node:child_process';
import { promisify } from 'node:util';
import { screen } from 'electron';

const execP = promisify(exec);

let proc: ChildProcessWithoutNullStreams | null = null;
let cachedScreen: { width: number; height: number } | null = null;

function ensureProc(): ChildProcessWithoutNullStreams {
  if (proc && !proc.killed && proc.exitCode === null) return proc;
  const p = spawn('xdotool', ['-'], { stdio: ['pipe', 'pipe', 'pipe'] });
  p.on('error', (err) => {
    console.warn('[hand-mouse] xdotool error:', err.message);
    if (proc === p) proc = null;
  });
  p.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`[hand-mouse] xdotool saiu com code=${code}`);
    }
    if (proc === p) proc = null;
  });
  proc = p;
  return p;
}

export function getScreenSize(): { width: number; height: number } {
  if (cachedScreen) return cachedScreen;
  // Electron `screen` é mais confiável que xdotool em multi-monitor.
  const display = screen.getPrimaryDisplay();
  cachedScreen = { width: display.bounds.width, height: display.bounds.height };
  return cachedScreen;
}

/** Move o cursor pra coordenadas absolutas (pixels). Throttled por chamador. */
export function moveMouseFast(x: number, y: number): void {
  const p = ensureProc();
  const px = Math.max(0, Math.round(x));
  const py = Math.max(0, Math.round(y));
  try {
    p.stdin.write(`mousemove ${px} ${py}\n`);
  } catch (err) {
    console.warn('[hand-mouse] write mousemove falhou:', err);
  }
}

/** Clica botão (1=esq, 2=meio, 3=dir). */
export function clickMouseFast(button: 1 | 2 | 3 = 1): void {
  const p = ensureProc();
  try {
    p.stdin.write(`click ${button}\n`);
  } catch (err) {
    console.warn('[hand-mouse] write click falhou:', err);
  }
}

/** Press/release pra drag. */
export function mouseDownFast(button: 1 | 2 | 3 = 1): void {
  const p = ensureProc();
  try {
    p.stdin.write(`mousedown ${button}\n`);
  } catch (err) {
    console.warn('[hand-mouse] write mousedown falhou:', err);
  }
}

export function mouseUpFast(button: 1 | 2 | 3 = 1): void {
  const p = ensureProc();
  try {
    p.stdin.write(`mouseup ${button}\n`);
  } catch (err) {
    console.warn('[hand-mouse] write mouseup falhou:', err);
  }
}

/** Scroll: 'up' ou 'down', N ticks (1 tick = 1 click do botão de scroll do mouse). */
export function scrollMouseFast(direction: 'up' | 'down', ticks = 1): void {
  const p = ensureProc();
  // xdotool: button 4 = scroll up, button 5 = scroll down
  const button = direction === 'up' ? 4 : 5;
  try {
    for (let i = 0; i < ticks; i++) {
      p.stdin.write(`click ${button}\n`);
    }
  } catch (err) {
    console.warn('[hand-mouse] write scroll falhou:', err);
  }
}

/** Encerra o processo persistente — chamar ao desativar o modo. */
export function stopHandMouse(): void {
  if (!proc) return;
  try {
    proc.stdin.end();
  } catch {
    /* ignore */
  }
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  proc = null;
}

/** Verifica se xdotool tá disponível no sistema (chamar uma vez na inicialização). */
export async function isXdotoolAvailable(): Promise<boolean> {
  try {
    await execP('which xdotool', { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}
