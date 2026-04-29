import { shell } from 'electron';
import { spawn } from 'node:child_process';
import type { ClientCommand } from '@assistant/shared';

export type ExecutionResult = { ok: true } | { ok: false; reason: string };

function searchUrl(query: string): string {
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
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
  }
}
