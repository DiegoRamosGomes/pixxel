// Controle de mídia (play/pause/próxima) do player que estiver tocando.
// Linux: playerctl (MPRIS) com fallback de tecla de mídia via xdotool.
// macOS: tecla de mídia do sistema via JXA (osascript).

import { spawn } from 'node:child_process';
import type { LocalToolResult } from '@assistant/shared';
import { mediaKeyScript } from './darwin.js';

export const MEDIA_OPS = ['play', 'pause', 'play_pause', 'stop', 'next', 'previous'] as const;
export type MediaOp = (typeof MEDIA_OPS)[number];

type CmdResult =
  | { ok: true }
  | { ok: false; missing: boolean; reason: string };

export function runCommand(cmd: string, args: string[]): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT = binário não instalado
      resolve({ ok: false, missing: err.code === 'ENOENT', reason: err.message });
    });
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, missing: false, reason: stderr.trim() || `${cmd} exit ${code}` });
    });
  });
}

const PLAYERCTL_OP: Record<MediaOp, string> = {
  play: 'play',
  pause: 'pause',
  play_pause: 'play-pause',
  stop: 'stop',
  next: 'next',
  previous: 'previous',
};

const XDOTOOL_KEY: Record<MediaOp, string> = {
  play: 'XF86AudioPlay',
  pause: 'XF86AudioPause',
  play_pause: 'XF86AudioPlay', // toggle na maioria dos players
  stop: 'XF86AudioStop',
  next: 'XF86AudioNext',
  previous: 'XF86AudioPrev',
};

async function mediaControlLinux(op: MediaOp): Promise<LocalToolResult> {
  const viaPlayerctl = await runCommand('playerctl', [PLAYERCTL_OP[op]]);
  if (viaPlayerctl.ok) return { ok: true };

  // playerctl rodou mas não achou player: xdotool não vai ajudar.
  if (!viaPlayerctl.missing && /no players? (found|could)/i.test(viaPlayerctl.reason)) {
    return {
      ok: false,
      reason: 'Nenhum player ativo encontrado. Inicie alguma música/vídeo (Spotify, navegador, etc.) e tente de novo.',
    };
  }

  const viaXdotool = await runCommand('xdotool', ['key', XDOTOOL_KEY[op]]);
  if (viaXdotool.ok) return { ok: true };

  const playerctlMsg = viaPlayerctl.missing ? '`playerctl` não está instalado' : `playerctl: ${viaPlayerctl.reason}`;
  const xdotoolMsg = viaXdotool.missing ? '`xdotool` não está instalado' : `xdotool: ${viaXdotool.reason}`;
  return { ok: false, reason: `Falhou nas duas vias — ${playerctlMsg}; ${xdotoolMsg}.` };
}

async function mediaControlDarwin(op: MediaOp): Promise<LocalToolResult> {
  // A tecla de mídia do macOS só tem play/pause (toggle), próxima e anterior.
  const key = op === 'next' ? 'next' : op === 'previous' ? 'previous' : 'play_pause';
  const r = await runCommand('osascript', ['-l', 'JavaScript', '-e', mediaKeyScript(key)]);
  return r.ok ? { ok: true } : { ok: false, reason: `tecla de mídia falhou: ${r.reason}` };
}

export async function mediaControl(op: MediaOp): Promise<LocalToolResult> {
  return process.platform === 'darwin' ? mediaControlDarwin(op) : mediaControlLinux(op);
}
