import 'dotenv/config';
import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistantWsClient } from './ws-client.js';
import type { RendererEvent } from '../shared/ipc.js';
import { isTtsAvailable, TtsEngine } from './voice/tts.js';
import { SentenceBuffer } from './voice/sentence-buffer.js';
import { GeminiLiveClient } from './voice/gemini-live.js';
import { ALL_TOOLS } from './voice/tool-declarations.js';
import { executeCommand } from './executor.js';
import { executeIntegration, INTEGRATION_NAMES } from './integrations/index.js';
import { ClientCommandSchema } from '@assistant/shared';
import { randomUUID } from 'node:crypto';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const WS_URL = process.env.WS_URL ?? 'ws://localhost:8080/ws';
const CLIENT_TOKEN = process.env.CLIENT_TOKEN ?? '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL;

let mainWindow: BrowserWindow | null = null;
let wsClient: AssistantWsClient | null = null;
let lastConn: RendererEvent | null = null;
let tts: TtsEngine | null = null;
let sentenceBuf: SentenceBuffer | null = null;
let live: GeminiLiveClient | null = null;

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
    mainWindow.webContents.openDevTools({ mode: 'detach' });
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

  // App local — autoriza mic/audio sem prompt. Sem isso, getUserMedia
  // no renderer falha silenciosamente e a sessão Live cai em 1006.
  // 'media' cobre mic e câmera no Chromium.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media';
  });

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

  ipcMain.handle('assistant:live-start', () => {
    if (!GEMINI_API_KEY) {
      const reason = 'GEMINI_API_KEY missing in .env';
      emit({ type: 'live_state', state: { kind: 'unavailable', reason } });
      return { ok: false, reason };
    }
    if (live) {
      // Already running — idempotente
      return { ok: true };
    }
    live = new GeminiLiveClient(
      GEMINI_API_KEY,
      {
        onState: (state) => {
          emit({ type: 'live_state', state });
          if (state.kind === 'closed' || state.kind === 'error' || state.kind === 'idle') {
            live = null;
          }
        },
        onAudio: (pcm) => {
          const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
          emit({ type: 'live_audio', pcm: ab, sampleRate: 24000 });
        },
        onTranscript: (text, role) =>
          emit({ type: 'live_transcript', role, text }),
        onToolCall: async (call) => {
          console.log('[live] tool call:', call.name, call.args);

          // Caminho 1: integrações (weather, clickup_*, play_youtube)
          if (INTEGRATION_NAMES.has(call.name)) {
            const intRes = await executeIntegration(call.name, call.args);
            if (intRes) {
              live?.sendToolResponse(call.id, call.name, intRes);
              return;
            }
          }

          // Caminho 2: client commands (open_app, open_url, web_search, media_control)
          const candidate = { action: call.name, ...call.args };
          const parsed = ClientCommandSchema.safeParse(candidate);
          if (!parsed.success) {
            const reason = `tool ${call.name}: args inválidos — ${parsed.error.issues.map((i) => i.message).join('; ')}`;
            console.warn('[live] tool call rejeitada:', reason);
            live?.sendToolResponse(call.id, call.name, { ok: false, reason });
            return;
          }
          const cmd = parsed.data;
          const result = await executeCommand(cmd);
          live?.sendToolResponse(call.id, call.name, result);
          emit({
            type: 'assistant_command',
            messageId: randomUUID(),
            command: cmd,
            spokenLabel: call.name,
            source: 'llm',
            executed: result,
          });
        },
      },
      { model: GEMINI_LIVE_MODEL, tools: ALL_TOOLS },
    );
    live.start();
    return { ok: true };
  });

  ipcMain.handle('assistant:live-stop', () => {
    live?.stop();
    live = null;
    emit({ type: 'live_state', state: { kind: 'idle' } });
  });

  let micChunkCount = 0;
  let micByteCount = 0;
  ipcMain.on('assistant:live-audio', (_event, pcm16k: ArrayBuffer) => {
    if (!live) return;
    micChunkCount += 1;
    micByteCount += pcm16k.byteLength;
    if (micChunkCount % 50 === 0) {
      console.log(
        `[live] mic chunks=${micChunkCount} totalBytes=${micByteCount} (${micChunkCount * 64}ms aprox)`,
      );
    }
    live.sendAudioChunk(Buffer.from(pcm16k));
  });

  ipcMain.on('assistant:live-end-turn', () => {
    live?.endTurn();
  });

  ipcMain.handle('assistant:live-send-text', (_event, text: string) => {
    if (!live) return { ok: false, reason: 'live_not_active' };
    const sent = live.sendText(text);
    return sent ? { ok: true } : { ok: false, reason: 'live_not_ready' };
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  wsClient?.close();
  tts?.cancel();
  live?.stop();
  if (process.platform !== 'darwin') app.quit();
});
