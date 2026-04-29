import 'dotenv/config';
import { app, BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistantWsClient } from './ws-client.js';
import type { RendererEvent } from '../shared/ipc.js';
import { isTtsAvailable, TtsEngine } from './voice/tts.js';
import { SentenceBuffer } from './voice/sentence-buffer.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const WS_URL = process.env.WS_URL ?? 'ws://localhost:8080/ws';
const CLIENT_TOKEN = process.env.CLIENT_TOKEN ?? '';

let mainWindow: BrowserWindow | null = null;
let wsClient: AssistantWsClient | null = null;
let lastConn: RendererEvent | null = null;
let tts: TtsEngine | null = null;
let sentenceBuf: SentenceBuffer | null = null;

function emit(event: RendererEvent): void {
  if (event.type === 'conn') lastConn = event;
  mainWindow?.webContents.send('assistant:event', event);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 880,
    height: 820,
    minWidth: 520,
    minHeight: 480,
    title: 'Jarvis',
    backgroundColor: '#07090d',
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

function emitTtsState(): void {
  emit({
    type: 'tts_state',
    enabled: tts?.isEnabled() ?? false,
    available: isTtsAvailable(),
  });
}

app.whenReady().then(() => {
  if (!CLIENT_TOKEN) {
    console.error('CLIENT_TOKEN missing in .env');
  }

  createWindow();

  tts = new TtsEngine({
    onSpeakingChange: (speaking) => emit({ type: 'tts_speaking', speaking }),
  });
  sentenceBuf = new SentenceBuffer();

  mainWindow?.webContents.on('did-finish-load', () => {
    console.log('[main] renderer ready, starting ws client');
    if (!wsClient) {
      wsClient = new AssistantWsClient(WS_URL, CLIENT_TOKEN, emit, {
        onAssistantTextChunk: (delta) => {
          if (!tts?.isEnabled()) return;
          const sentences = sentenceBuf!.push(delta);
          for (const s of sentences) tts!.enqueue(s);
        },
        onAssistantTextEnd: () => {
          const tail = sentenceBuf!.flush();
          if (tail && tts?.isEnabled()) tts.enqueue(tail);
        },
        onAssistantCommandLabel: (label) => {
          if (tts?.isEnabled()) tts.enqueue(label);
        },
      });
      wsClient.connect();
    } else if (lastConn) {
      mainWindow?.webContents.send('assistant:event', lastConn);
    }
    emitTtsState();
  });

  ipcMain.handle('assistant:send-text', (_event, text: string) => {
    wsClient?.sendText(text);
  });

  ipcMain.handle('assistant:toggle-tts', () => {
    if (!tts) return { enabled: false, available: false };
    if (!isTtsAvailable()) {
      return { enabled: false, available: false };
    }
    tts.setEnabled(!tts.isEnabled());
    sentenceBuf?.reset();
    const next = { enabled: tts.isEnabled(), available: true };
    emit({ type: 'tts_state', ...next });
    return next;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  wsClient?.close();
  tts?.cancel();
  if (process.platform !== 'darwin') app.quit();
});
