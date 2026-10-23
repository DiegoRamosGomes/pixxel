// Reinicia o Electron. Empacotado: app.relaunch. Em dev (electron-vite) o
// relaunch solto mata o terminal pai, então sobe um `npm run dev:desktop`
// destacado que espera o processo atual morrer.

import { spawn } from 'node:child_process';
import { resolve as pathResolve } from 'node:path';
import { app } from 'electron';

export function restartApp(): void {
  if (app.isPackaged) {
    app.relaunch();
    app.exit(0);
    return;
  }
  const repoRoot = pathResolve(app.getAppPath(), '..', '..');
  try {
    const child = spawn('sh', ['-c', `sleep 2; cd "${repoRoot}" && npm run dev:desktop`], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    });
    child.unref();
  } catch (err) {
    console.warn('[restart_app] falha ao spawnar dev:desktop:', err);
  }
  app.exit(0);
}
