// Controle de mouse por gestos. Linux: xdotool em modo persistente. macOS:
// cliclick (um processo por comando, movimentos coalescidos).
//
// Diferente do input-xdotool.ts (que spawna xdotool a cada comando, custo
// ~10ms por chamada), aqui mantemos UM processo `xdotool -` vivo e mandamos
// comandos via stdin. Necessário pra hand-tracking em 15-30 fps, onde
// spawnar a cada frame estouraria CPU.
//
// Comandos suportados pelo xdotool stdin: "mousemove X Y", "click N", etc.
// Veja `man xdotool` (seção "MULTIPLE COMMANDS").

import { spawn, type ChildProcessWithoutNullStreams, exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { screen } from 'electron';

const execP = promisify(exec);
const execFileP = promisify(execFile);
const isMac = (): boolean => process.platform === 'darwin';

// ===== macOS: cliclick, um processo por comando =====
// Gestos mandam dezenas de movimentos por segundo; com um cliclick em voo,
// só a última posição pendente vale (as intermediárias são descartadas).
let macMoveInFlight = false;
let macPendingMove: { x: number; y: number } | null = null;
let macScrollWarned = false;

function cliclick(...args: string[]): Promise<void> {
  return execFileP('cliclick', args, { timeout: 5000 }).then(
    () => undefined,
    (err: Error) => console.warn('[hand-mouse] cliclick falhou:', err.message),
  );
}

function macMove(x: number, y: number): void {
  if (macMoveInFlight) {
    macPendingMove = { x, y };
    return;
  }
  macMoveInFlight = true;
  void cliclick(`m:${x},${y}`).finally(() => {
    macMoveInFlight = false;
    const next = macPendingMove;
    macPendingMove = null;
    if (next) macMove(next.x, next.y);
  });
}

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
  const px = Math.max(0, Math.round(x));
  const py = Math.max(0, Math.round(y));
  if (isMac()) {
    macMove(px, py);
    return;
  }
  const p = ensureProc();
  try {
    p.stdin.write(`mousemove ${px} ${py}\n`);
  } catch (err) {
    console.warn('[hand-mouse] write mousemove falhou:', err);
  }
}

/** Clica botão (1=esq, 2=meio, 3=dir). */
export function clickMouseFast(button: 1 | 2 | 3 = 1): void {
  if (isMac()) {
    void cliclick(button === 3 ? 'rc:.' : 'c:.');
    return;
  }
  const p = ensureProc();
  try {
    p.stdin.write(`click ${button}\n`);
  } catch (err) {
    console.warn('[hand-mouse] write click falhou:', err);
  }
}

/** Press/release pra drag. */
export function mouseDownFast(button: 1 | 2 | 3 = 1): void {
  if (isMac()) {
    void cliclick('dd:.');
    return;
  }
  const p = ensureProc();
  try {
    p.stdin.write(`mousedown ${button}\n`);
  } catch (err) {
    console.warn('[hand-mouse] write mousedown falhou:', err);
  }
}

export function mouseUpFast(button: 1 | 2 | 3 = 1): void {
  if (isMac()) {
    void cliclick('du:.');
    return;
  }
  const p = ensureProc();
  try {
    p.stdin.write(`mouseup ${button}\n`);
  } catch (err) {
    console.warn('[hand-mouse] write mouseup falhou:', err);
  }
}

/** Scroll: 'up' ou 'down', N ticks (1 tick = 1 click do botão de scroll do mouse). */
export function scrollMouseFast(direction: 'up' | 'down', ticks = 1): void {
  if (isMac()) {
    // cliclick não tem scroll — gesto de rolagem fica sem efeito no Mac.
    if (!macScrollWarned) console.warn('[hand-mouse] scroll não suportado no macOS');
    macScrollWarned = true;
    return;
  }
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
  macPendingMove = null;
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

/** Pode ligar o modo gesto? No Mac depende de cliclick + Acessibilidade. */
export async function handMouseAvailable(): Promise<{ ok: boolean; reason?: string }> {
  if (isMac()) {
    const { inputUnavailableReason } = await import('./input.js');
    const why = await inputUnavailableReason();
    return why ? { ok: false, reason: why } : { ok: true };
  }
  return (await isXdotoolAvailable()) ? { ok: true } : { ok: false, reason: 'xdotool não instalado' };
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
