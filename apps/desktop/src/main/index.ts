import 'dotenv/config';
import { app, BrowserWindow, Menu, globalShortcut, ipcMain, session } from 'electron';
import { hostname } from 'node:os';
import { join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNetworkPoll, startSystemMetrics, startTopProcesses } from '@assistant/metrics';
import type { RendererEvent } from '../shared/ipc.js';
import { ApiClient } from './api-client.js';
import { executeLocalOp, supportedLocalOps } from './local/index.js';
import { deliverFrame } from './local/camera.js';
import { startWifiPoll } from './local/wifi.js';
import {
  isXdotoolAvailable,
  getScreenSize as getHandMouseScreenSize,
  moveMouseFast,
  clickMouseFast,
  mouseDownFast,
  mouseUpFast,
  scrollMouseFast,
  stopHandMouse,
} from './local/hand-mouse.js';

// O Electron é a casca: janela, áudio, câmera e funções locais. Toda a
// lógica (voz, integrações, memória) roda na API — ver apps/backend.

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const API_URL = process.env.API_URL ?? 'http://localhost:8080';
const CLIENT_TOKEN = process.env.CLIENT_TOKEN ?? '';

// Diretório do projeto ativo (definido por open_project). Default: raiz do
// monorepo deste projeto (subindo de apps/desktop/out/main). Override via
// PIXXEL_PROJECT_DIR.
const DEFAULT_PROJECT_DIR = process.env.PIXXEL_PROJECT_DIR ?? pathResolve(__dirname, '../../../..');
let activeProjectCwd = DEFAULT_PROJECT_DIR;
let activeProjectName: string | null = null;

let mainWindow: BrowserWindow | null = null;
let api: ApiClient | null = null;
let lastConn: RendererEvent | null = null;

// Cleanups dos pollers de longa duração. Chamados no shutdown pra evitar
// setIntervals órfãos mandando IPC pra webContents destruído.
const shutdownHandlers: Array<() => void> = [];

function setActiveProject(path: string, name: string | null): void {
  if (path === activeProjectCwd && name === activeProjectName) return;
  activeProjectCwd = path;
  activeProjectName = name;
  console.log(`[project] ativo: ${name ?? '(default)'} ${path}`);
  emit({ type: 'active_project', path, name });
}

function emit(event: RendererEvent): void {
  if (event.type === 'conn') lastConn = event;
  // Guard contra webContents destruído (poller fazendo um último tick no shutdown).
  const wc = mainWindow?.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send('assistant:event', event);
}

function createWindow(): void {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 880,
    height: 820,
    minWidth: 520,
    minHeight: 480,
    title: 'Pixxel',
    backgroundColor: '#07090d',
    autoHideMenuBar: true,
    frame: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.maximize();

  // Shutdown limpo: quando a janela morre, cancela pollers e sai.
  mainWindow.on('closed', () => {
    console.log('[shutdown] mainWindow closed — encerrando');
    mainWindow = null;
    shutdownAll();
    setTimeout(() => app.exit(0), 200);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    // DevTools só abre se OPEN_DEVTOOLS=1 (debug pontual).
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  if (!CLIENT_TOKEN) console.error('CLIENT_TOKEN missing in .env');

  // Esc global = aborta apresentação em curso na API (que ignora se não houver).
  try {
    globalShortcut.register('Escape', () => api?.abortPresentation());
  } catch (err) {
    console.warn('[shortcut] Esc register falhou:', err);
  }

  // Barra lateral: métricas da máquina local.
  shutdownHandlers.push(
    startSystemMetrics((m) => {
      emit({
        type: 'system_metrics',
        cpuPercent: m.cpuPercent,
        memUsedBytes: m.memUsedBytes,
        memTotalBytes: m.memTotalBytes,
      });
    }),
    startTopProcesses((s) => emit({ type: 'top_processes', topCpu: s.topCpu, topMem: s.topMem })),
    startWifiPoll((w) => emit({ type: 'wifi_info', ssid: w.ssid, signal: w.signal })),
    startNetworkPoll((s) =>
      emit({ type: 'network_bw', rxBytesPerSec: s.rxBytesPerSec, txBytesPerSec: s.txBytesPerSec }),
    ),
  );

  // App local — autoriza mic/câmera sem prompt do Chromium. Sem isso,
  // getUserMedia no renderer falha silenciosamente.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');

  createWindow();

  api = new ApiClient({
    apiUrl: API_URL,
    token: CLIENT_TOKEN,
    clientId: `desktop-${hostname()}`,
    localOps: supportedLocalOps(),
    emit,
    runLocalOp: (op, args) => executeLocalOp(op, args, { emit, setActiveProject }),
  });
  api.connect();

  // did-finish-load pode disparar de novo em reloads — a voz só liga uma vez.
  let voiceAutoStarted = false;
  mainWindow?.webContents.on('did-finish-load', () => {
    if (lastConn) emit(lastConn);
    emit({ type: 'active_project', path: activeProjectCwd, name: activeProjectName });
    if (voiceAutoStarted) return;
    voiceAutoStarted = true;
    // Pequeno delay pro React registrar o listener de eventos.
    setTimeout(() => api?.voiceStart(), 300);
  });

  ipcMain.handle('assistant:memory-graph', () => api?.memoryGraph() ?? { nodes: [], edges: [] });

  ipcMain.on('assistant:camera-frame', (_event, requestId: string, dataUrl: string | null) => {
    deliverFrame(requestId, dataUrl);
  });

  ipcMain.handle(
    'assistant:instagram-publish',
    async (_event, fileBytes: ArrayBuffer, fileName: string, caption: string, shareToFeed = false) => {
      if (!api) return { ok: false, reason: 'API indisponível' };
      return api.instagramPublish(fileBytes, fileName, caption, shareToFeed);
    },
  );

  // ===== Hand-mouse (controle do cursor por gestos) =====
  ipcMain.handle('assistant:hand-mouse-enable', async () => {
    const has = await isXdotoolAvailable();
    if (!has) return { ok: false, reason: 'xdotool não instalado' };
    return { ok: true, screen: getHandMouseScreenSize() };
  });
  ipcMain.handle('assistant:hand-mouse-disable', () => {
    stopHandMouse();
  });
  ipcMain.on('assistant:hand-mouse-move', (_e, x: number, y: number) => moveMouseFast(x, y));
  ipcMain.on('assistant:hand-mouse-click', (_e, button: 1 | 2 | 3) => clickMouseFast(button));
  ipcMain.on('assistant:hand-mouse-down', (_e, button: 1 | 2 | 3) => mouseDownFast(button));
  ipcMain.on('assistant:hand-mouse-up', (_e, button: 1 | 2 | 3) => mouseUpFast(button));
  ipcMain.on('assistant:hand-mouse-scroll', (_e, direction: 'up' | 'down', ticks: number) =>
    scrollMouseFast(direction, ticks),
  );

  // Usuário clicou numa notificação ClickUp → a API pede pro Gemini explicar a task.
  ipcMain.on('assistant:explain-clickup-task', (_e, taskId: string) => {
    api?.explainClickupTask(String(taskId));
  });

  ipcMain.on('assistant:window-close', () => mainWindow?.close());
  ipcMain.on('assistant:window-minimize', () => mainWindow?.minimize());
  ipcMain.on('assistant:window-maximize-toggle', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  // ===== Voz (a sessão Gemini Live roda na API) =====
  ipcMain.handle('assistant:live-start', () => {
    api?.voiceStart();
    return { ok: true };
  });
  ipcMain.handle('assistant:live-stop', () => {
    api?.voiceStop();
    emit({ type: 'live_state', state: { kind: 'idle' } });
  });
  ipcMain.on('assistant:live-audio', (_event, pcm16k: ArrayBuffer) => {
    api?.sendAudio(pcm16k);
  });
  ipcMain.on('assistant:live-end-turn', () => {
    api?.endTurn();
  });
  ipcMain.handle('assistant:live-send-text', (_event, text: string) => {
    return api?.sendText(text) ?? { ok: false, reason: 'api_offline' };
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function shutdownAll(): void {
  for (const cancel of shutdownHandlers) {
    try {
      cancel();
    } catch (err) {
      console.warn('[shutdown] handler falhou:', err);
    }
  }
  shutdownHandlers.length = 0;
  api?.close();
  api = null;
  stopHandMouse();
}

app.on('window-all-closed', () => {
  shutdownAll();
  if (process.platform !== 'darwin') {
    // app.quit() pode ficar pendurado se algo segurar o event loop. Fallback: força exit.
    app.quit();
    setTimeout(() => {
      console.warn('[shutdown] app.quit não completou, forçando exit');
      app.exit(0);
    }, 1000);
  }
});

// Se app.quit() for chamado por outro caminho (Cmd+Q, SIGTERM...), fecha tudo também.
app.on('before-quit', () => {
  shutdownAll();
});
