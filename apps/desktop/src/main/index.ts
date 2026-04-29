import 'dotenv/config';
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistantWsClient } from './ws-client.js';
import type { RendererEvent } from '../shared/ipc.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const WS_URL = process.env.WS_URL ?? 'ws://localhost:8080/ws';
const CLIENT_TOKEN = process.env.CLIENT_TOKEN ?? '';

let mainWindow: BrowserWindow | null = null;
let wsClient: AssistantWsClient | null = null;
let lastConn: RendererEvent | null = null;

function emit(event: RendererEvent): void {
  if (event.type === 'conn') lastConn = event;
  mainWindow?.webContents.send('assistant:event', event);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 800,
    title: 'Jarvis',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

app.whenReady().then(() => {
  if (!CLIENT_TOKEN) {
    console.error('CLIENT_TOKEN missing in .env');
  }

  createWindow();

  // Só conecta o WS depois que o renderer terminou de carregar e registrou o listener.
  // Isso evita perder o `conn: open` numa race condition no startup.
  mainWindow?.webContents.on('did-finish-load', () => {
    console.log('[main] renderer ready, starting ws client');
    if (!wsClient) {
      wsClient = new AssistantWsClient(WS_URL, CLIENT_TOKEN, emit);
      wsClient.connect();
    } else if (lastConn) {
      // Reload do renderer — re-emite o último estado conhecido.
      mainWindow?.webContents.send('assistant:event', lastConn);
    }
  });

  ipcMain.handle('assistant:send-text', (_event, text: string) => {
    wsClient?.sendText(text);
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  wsClient?.close();
  if (process.platform !== 'darwin') app.quit();
});
