// Abrir programas e URLs na máquina local.

import { spawn } from 'node:child_process';
import { shell } from 'electron';
import type { LocalToolResult } from '@assistant/shared';

export async function openApp(name: string): Promise<LocalToolResult> {
  if (!name) return { ok: false, reason: 'nome do app vazio' };
  // macOS: `open -a` resolve pelo nome do .app ("Spotify", "Visual Studio Code").
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-a', name]] : [name, []];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      resolve({ ok: false, reason: `não consegui executar "${name}": ${err.message}` });
    });
    child.on('spawn', () => {
      child.unref();
      if (process.platform !== 'darwin') {
        resolve({ ok: true });
        return;
      }
      // `open -a` sai com código != 0 quando o app não existe.
      child.on('exit', (code) => {
        resolve(code === 0 ? { ok: true } : { ok: false, reason: `app "${name}" não encontrado` });
      });
    });
  });
}

export async function openUrl(url: string): Promise<LocalToolResult> {
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'URL inválida.' };
  try {
    await shell.openExternal(url);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'erro desconhecido' };
  }
}
