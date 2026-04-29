import { shell } from 'electron';
import { spawn } from 'node:child_process';
import type { ClientCommand, MediaControlCommand } from '@assistant/shared';

export type ExecutionResult = { ok: true } | { ok: false; reason: string };

function searchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

type CmdResult =
  | { ok: true }
  | { ok: false; missing: true; reason: string }
  | { ok: false; missing: false; reason: string };

function runCommand(cmd: string, args: string[]): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      // ENOENT = binário não instalado
      const missing = err.code === 'ENOENT';
      resolve({ ok: false, missing, reason: err.message });
    });
    child.on('exit', (code) => {
      if (code === 0) resolve({ ok: true });
      else
        resolve({
          ok: false,
          missing: false,
          reason: stderr.trim() || `${cmd} exit ${code}`,
        });
    });
  });
}

async function openApp(name: string): Promise<ExecutionResult> {
  return new Promise((resolve) => {
    const child = spawn(name, [], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      resolve({ ok: false, reason: `não consegui executar "${name}": ${err.message}` });
    });
    child.on('spawn', () => {
      child.unref();
      resolve({ ok: true });
    });
  });
}

const PLAYERCTL_OP: Record<MediaControlCommand['op'], string> = {
  play: 'play',
  pause: 'pause',
  play_pause: 'play-pause',
  stop: 'stop',
  next: 'next',
  previous: 'previous',
};

const XDOTOOL_KEY: Record<MediaControlCommand['op'], string> = {
  play: 'XF86AudioPlay',
  pause: 'XF86AudioPause',
  play_pause: 'XF86AudioPlay', // toggle no maioria dos players
  stop: 'XF86AudioStop',
  next: 'XF86AudioNext',
  previous: 'XF86AudioPrev',
};

async function mediaControl(op: MediaControlCommand['op']): Promise<ExecutionResult> {
  // Tenta playerctl primeiro (atinge MPRIS — Spotify, navegadores, etc.)
  const viaPlayerctl = await runCommand('playerctl', [PLAYERCTL_OP[op]]);
  if (viaPlayerctl.ok) return viaPlayerctl;

  // Se playerctl rodou mas reportou ausência/inação de player, não vale tentar
  // xdotool — o problema não é falta de ferramenta, é falta de player ativo.
  // Mensagens do playerctl: "No players found", "No player could handle this command".
  if (!viaPlayerctl.missing && /no players? (found|could)/i.test(viaPlayerctl.reason)) {
    return {
      ok: false,
      reason:
        'Nenhum player ativo encontrado. Inicie alguma música/vídeo (Spotify, navegador, etc.) e tente de novo.',
    };
  }

  // Fallback: xdotool envia o evento de tecla de mídia pro sistema
  const viaXdotool = await runCommand('xdotool', ['key', XDOTOOL_KEY[op]]);
  if (viaXdotool.ok) return viaXdotool;

  // Mensagem detalhada por caso
  const playerctlMsg = viaPlayerctl.missing
    ? '`playerctl` não está instalado'
    : `playerctl: ${viaPlayerctl.reason}`;
  const xdotoolMsg = viaXdotool.missing
    ? '`xdotool` não está instalado'
    : `xdotool: ${viaXdotool.reason}`;

  return {
    ok: false,
    reason: `Falhou nas duas vias — ${playerctlMsg}; ${xdotoolMsg}.`,
  };
}

export async function executeCommand(cmd: ClientCommand): Promise<ExecutionResult> {
  switch (cmd.action) {
    case 'open_app':
      return openApp(cmd.name);
    case 'open_url':
      try {
        await shell.openExternal(cmd.url);
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'erro desconhecido',
        };
      }
    case 'web_search':
      try {
        await shell.openExternal(searchUrl(cmd.query));
        return { ok: true };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : 'erro desconhecido',
        };
      }
    case 'media_control':
      return mediaControl(cmd.op);
  }
}
