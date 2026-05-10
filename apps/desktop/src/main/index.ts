import 'dotenv/config';
import { app, BrowserWindow, Menu, globalShortcut, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistantWsClient } from './ws-client.js';
import type { RendererEvent } from '../shared/ipc.js';
import { isTtsAvailable, TtsEngine } from './voice/tts.js';
import { SentenceBuffer } from './voice/sentence-buffer.js';
import { GeminiLiveClient } from './voice/gemini-live.js';
import {
  ALL_TOOLS,
  UI_TOOL_NAMES,
  IDEAS_TOOL_NAMES,
} from './voice/tool-declarations.js';
import { saveIdea } from './integrations/ideas.js';
import {
  getStudyPlanStore,
  seedKamilaPlanIfMissing,
  applyKamilaCuratedVideos,
} from './integrations/study-plans.js';
import { getActiveWorkStore } from './integrations/active-work.js';
import { executeCommand } from './executor.js';
import { executeIntegration, INTEGRATION_NAMES } from './integrations/index.js';
import { deliverFrame, registerFrameRequester } from './integrations/vision.js';
import {
  isFirstBriefingOfDay,
  markBriefingDoneToday,
} from './integrations/briefing.js';
import {
  startClickupNotificationsPoller,
  type NotificationsBatch,
} from './integrations/clickup-notifications.js';
import {
  isXdotoolAvailable,
  getScreenSize as getHandMouseScreenSize,
  moveMouseFast,
  clickMouseFast,
  mouseDownFast,
  mouseUpFast,
  scrollMouseFast,
  stopHandMouse,
} from './integrations/hand-mouse.js';
import {
  indexMemoryEntry,
  indexWorklogFile,
  initializeEmbeddings,
  unindexMemoryEntry,
} from './integrations/embeddings.js';
import { ClientCommandSchema } from '@assistant/shared';
import { randomUUID } from 'node:crypto';
import { resolve as pathResolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Widget } from '../shared/widgets.js';
import { MemoryVault, type MemoryType } from './memory.js';
import { startSystemMetrics } from './system-metrics.js';
import { startTopProcesses } from './top-processes.js';
import { startWifiPoll } from './wifi.js';
import { startNetworkPoll } from './network.js';
import { startEmailPoller } from './integrations/email/poller.js';
import {
  backfillEmails,
  hasBackfilled,
  isGmailAvailable as isEmailAvailable,
} from './integrations/email/index.js';
import { formatImportantSummary } from './integrations/index.js';
import { isNtfyAvailable, sendNtfy } from './integrations/email/notifier.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Diretório do projeto ativo (definido por open_project). Default: raiz do
// monorepo deste projeto (subindo de apps/desktop/out/main). Override via
// PIXXEL_PROJECT_DIR.
const DEFAULT_PROJECT_DIR =
  process.env.PIXXEL_PROJECT_DIR ?? pathResolve(__dirname, '../../../..');
let activeProjectCwd = DEFAULT_PROJECT_DIR;
let activeProjectName: string | null = null;

function setActiveProject(path: string, name: string | null): void {
  if (path === activeProjectCwd && name === activeProjectName) return;
  activeProjectCwd = path;
  activeProjectName = name;
  console.log(`[project] ativo: ${name ?? '(default)'} ${path}`);
  emit({ type: 'active_project', path, name });
}

function ttlForWidget(kind: string): number {
  switch (kind) {
    case 'weather':
      return 30_000;
    case 'tasks-list':
      return 60_000;
    case 'task-detail':
      return 90_000;
    case 'youtube':
      return 45_000;
    case 'search-results':
      return 90_000;
    default:
      return 30_000;
  }
}

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
let memory: MemoryVault | null = null;
// Reconnect automático do Gemini Live. `liveDesiredActive` reflete a intenção
// do usuário (true entre live-start e live-stop). Quando o WS cai sem ser stop
// manual (ex: code 1011 do Google), agenda re-tentativa com backoff.
let liveDesiredActive = false;
let liveReconnectTimer: NodeJS.Timeout | null = null;
let liveReconnectAttempt = 0;
const LIVE_RECONNECT_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000, 60_000];
// Cinta de segurança pro briefing: só roda uma vez por sessão Live, mesmo
// que Gemini chame de novo por engano. Reset no live-start.
let briefingHandledThisSession = false;
// Detecção de "Gemini hallucina sobre estado". Quando user transcript matchar
// uma pergunta de estado, força chamada antecipada de current_work_status
// se Gemini não chamou em 4s.
let pendingStateCheck: NodeJS.Timeout | null = null;
let lastCurrentWorkStatusAtMs = 0;

// Estado atual do Gemini Live, espelhado em main.
let liveStateKind: 'idle' | 'connecting' | 'ready' | 'speaking' | 'unavailable' | 'error' | 'closed' = 'idle';

// Lista de cleanups dos pollers de longa duração. Chamados em
// 'window-all-closed' pra evitar setIntervals órfãos que tentam mandar IPC
// pra webContents destruído ("Object has been destroyed").
const shutdownHandlers: Array<() => void> = [];

// Frases de webhook pendentes que chegaram enquanto Live ainda não tava
// 'ready'. Flushadas agregadas quando Live conecta — evita perder fala e
// já resolve o "muitas notificações ao reconectar" naturalmente.
const pendingWebhookPhrases: string[] = [];

// Trata um webhook que chegou via backend WS. Mapeia provider/eventKind pro
// widget correto + frase pro Gemini falar. Hoje cobre só Expo build, mas
// estrutura é genérica pra outros providers no futuro.
function handleWebhookEvent(wh: {
  eventId: string;
  provider: string;
  eventKind: string;
  receivedAt: number;
  data: Record<string, unknown>;
}): void {
  console.log(
    `[webhook] recebido: ${wh.provider}/${wh.eventKind} id=${wh.eventId}`,
  );
  if (wh.provider === 'expo') {
    handleExpoBuildEvent(wh);
    return;
  }
  console.warn(`[webhook] provider desconhecido: ${wh.provider}`);
}

function handleExpoBuildEvent(wh: {
  eventId: string;
  eventKind: string;
  receivedAt: number;
  data: Record<string, unknown>;
}): void {
  const d = wh.data;
  const status = String(d.status ?? '');
  const platform = (d.platform as 'ios' | 'android' | undefined) ?? undefined;
  const appName = typeof d.appName === 'string' ? d.appName : undefined;
  const buildId = typeof d.buildId === 'string' ? d.buildId : undefined;
  const buildUrl = typeof d.buildUrl === 'string' ? d.buildUrl : undefined;
  const artifactUrl = typeof d.artifactUrl === 'string' ? d.artifactUrl : undefined;

  // Frase pro Gemini falar dependendo do status
  const platLabel = platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : '';
  const appLabel = appName ?? 'seu app';
  let phrase = '';
  if (wh.eventKind === 'expo.build.started') {
    phrase = `Build do ${appLabel}${platLabel ? ' pra ' + platLabel : ''} começou. Pode ir se preparando pra testar.`;
  } else if (wh.eventKind === 'expo.build.finished') {
    phrase = `Build do ${appLabel}${platLabel ? ' pra ' + platLabel : ''} terminou com sucesso.`;
  } else if (wh.eventKind === 'expo.build.errored') {
    phrase = `Build do ${appLabel}${platLabel ? ' pra ' + platLabel : ''} falhou.`;
  } else if (wh.eventKind === 'expo.build.canceled') {
    phrase = `Build do ${appLabel} foi cancelado.`;
  } else {
    phrase = `Atualização de build do ${appLabel}: ${status}.`;
  }

  // Live pode não estar pronto ainda (boot do app, reconnect). Bufferiza
  // a frase e flusha quando Live entrar em 'ready'.
  enqueueWebhookSpeech(phrase);

  emit({
    type: 'widget',
    id: randomUUID(),
    widget: {
      kind: 'build-status',
      provider: 'expo',
      buildId,
      appName,
      platform,
      status: (status || 'unknown') as 'started' | 'finished' | 'errored' | 'canceled' | string,
      buildUrl,
      artifactUrl,
      receivedAt: wh.receivedAt,
    },
    ttlMs: 60_000 * 60, // 1h na tela
  });
}

/** Adiciona uma frase pra ser falada quando Live estiver pronto. Se já
 *  estiver ready, fala imediato. Senão, fica na buffer. */
function enqueueWebhookSpeech(phrase: string): void {
  pendingWebhookPhrases.push(phrase);
  const liveReady = liveStateKind === 'ready' || liveStateKind === 'speaking';
  if (live && liveReady) flushPendingWebhookPhrases();
}

/** Junta todas as frases pendentes numa única instrução pro Gemini. */
function flushPendingWebhookPhrases(): void {
  if (pendingWebhookPhrases.length === 0) return;
  if (!live || liveStateKind !== 'ready') return;
  const phrases = pendingWebhookPhrases.splice(0);
  let body: string;
  if (phrases.length === 1) {
    body = phrases[0];
  } else {
    body =
      `Tem ${phrases.length} novidades de build acumuladas: ` +
      phrases.map((p, i) => `${i + 1}) ${p}`).join(' ');
  }
  live.sendText(
    `[evento interno — não é fala do usuário] Avise o usuário em frase ` +
      `natural e curta sobre os builds abaixo, sem chamar tool e sem ` +
      `adicionar detalhes. Conteúdo:\n\n${body}`,
  );
  console.log(`[webhook] flushed ${phrases.length} pending phrase(s) → Gemini`);
}

function emit(event: RendererEvent): void {
  if (event.type === 'conn') lastConn = event;
  // Guard contra webContents destruído (acontece durante shutdown se algum
  // poller ainda fizer um último tick antes de cancelar).
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

  // Garantia de shutdown limpo: quando a janela morre, força exit imediato
  // depois de cancelar pollers. Sem isso o main process pode ficar pendurado
  // por causa de WebSockets/IMAP/child_process abertos.
  mainWindow.on('closed', () => {
    console.log('[shutdown] mainWindow closed — encerrando');
    mainWindow = null;
    shutdownAll();
    // Pequeno delay pra logs flushearem antes de exit hard.
    setTimeout(() => {
      console.log('[shutdown] app.exit(0)');
      app.exit(0);
    }, 200);
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
    // DevTools só abre se OPEN_DEVTOOLS=1 (debug pontual).
    // Manualmente: View → Toggle Developer Tools, ou Ctrl+Shift+I.
    if (process.env.OPEN_DEVTOOLS === '1') {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
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

app.whenReady().then(async () => {
  if (!CLIENT_TOKEN) {
    console.error('CLIENT_TOKEN missing in .env');
  }

  // Migração one-time: ~/jarvis/ → ~/pixxel/. Renomeia se ~/pixxel/ ainda
  // não existe e ~/jarvis/ existe. Preserva todos os dados do usuário
  // (memory, work-log, study-plans, state, active-work.json).
  try {
    const { existsSync, renameSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');
    const oldDir = join(homedir(), 'jarvis');
    const newDir = join(homedir(), 'pixxel');
    if (existsSync(oldDir) && !existsSync(newDir)) {
      renameSync(oldDir, newDir);
      console.log(`[migrate] ~/jarvis → ~/pixxel (preservado)`);
    }
  } catch (err) {
    console.warn('[migrate] rename ~/jarvis → ~/pixxel falhou:', err);
  }

  memory = new MemoryVault();
  await memory.load();
  // Index semântico (Gemini Embedding 2). Roda em background — não bloqueia.
  initializeEmbeddings(memory);

  // Planos de estudo persistentes (~/pixxel/study-plans/) — seedz o da Kamila
  // na 1ª execução pra não perder o roteiro original.
  const studyStore = getStudyPlanStore();
  await studyStore.load();
  await seedKamilaPlanIfMissing(studyStore);
  await applyKamilaCuratedVideos(studyStore);
  // Tracker de sessões de trabalho (start_work/end_work) — persistido em
  // ~/pixxel/active-work.json. Briefing matinal lê pra sugerir continuar.
  await getActiveWorkStore().load();

  // Esc global = aborta apresentação em curso. Não interfere quando demo não
  // está rodando — o handler só seta a flag, a demo lê e para.
  try {
    globalShortcut.register('Escape', async () => {
      const { isPresentationRunning, isMouseKeyboardTestRunning, cancelPresentation } =
        await import('./integrations/presentation.js');
      if (isPresentationRunning() || isMouseKeyboardTestRunning()) {
        console.log('[demo] Esc → cancelando');
        cancelPresentation();
      }
    });
  } catch (err) {
    console.warn('[shortcut] Esc register falhou:', err);
  }

  // Métricas de sistema pra sidebar (CPU + memória). Roda enquanto o app
  // tá vivo, broadcast cada 5s. Cancel registrado pra shutdown limpo.
  shutdownHandlers.push(
    startSystemMetrics((m) => {
      emit({
        type: 'system_metrics',
        cpuPercent: m.cpuPercent,
        memUsedBytes: m.memUsedBytes,
        memTotalBytes: m.memTotalBytes,
      });
    }),
  );

  // Top processos (CPU + memória) — poll mais lento (8s) por causa do spawn.
  shutdownHandlers.push(
    startTopProcesses((s) => {
      emit({ type: 'top_processes', topCpu: s.topCpu, topMem: s.topMem });
    }),
  );

  // WiFi (nmcli) — polling lento, raramente muda.
  shutdownHandlers.push(
    startWifiPoll((w) => {
      emit({ type: 'wifi_info', ssid: w.ssid, signal: w.signal });
    }),
  );

  // Banda de rede (/proc/net/dev).
  shutdownHandlers.push(
    startNetworkPoll((s) => {
      emit({
        type: 'network_bw',
        rxBytesPerSec: s.rxBytesPerSec,
        txBytesPerSec: s.txBytesPerSec,
      });
    }),
  );

  // Backfill dos últimos 100 emails na primeira execução — só pra busca
  // semântica funcionar com histórico. Roda em background, não bloqueia.
  if (isEmailAvailable()) {
    void (async () => {
      try {
        if (await hasBackfilled()) {
          console.log('[email] backfill já feito, pulando');
          return;
        }
        // Espera 1min depois do startup pra não competir com outras inits.
        await new Promise((r) => setTimeout(r, 60_000));
        console.log('[email] backfill inicial — indexando últimos 100 emails');
        const r = await backfillEmails(100);
        console.log(
          `[email] backfill: indexou ${r.indexed}, pulou ${r.skipped}` +
            (r.reason ? ` (erro: ${r.reason})` : ''),
        );
      } catch (err) {
        console.warn('[email] backfill falhou:', err);
      }
    })();
  }

  // Email poller — IMAP a cada 5min. Quando achar importante:
  //   1) fala via Live (se ativa)
  //   2) manda WhatsApp via CallMeBot (se configurado) — chega no celular.
  shutdownHandlers.push(
    startEmailPoller({
      onImportant: (emails) => {
      const summary = formatImportantSummary(emails, emails.length);
      console.log(`[email] ${emails.length} importante(s) detectado(s)`);

      const liveReady = liveStateKind === 'ready' || liveStateKind === 'speaking';
      if (live && liveReady) {
        live.sendText(
          `[evento interno — não é fala do usuário] Acabou de chegar email ` +
            `importante. Avise o usuário em UMA frase curta e natural ` +
            `mencionando o(s) remetente(s). NÃO leia URLs nem detalhes ` +
            `técnicos. NÃO chame tools.\n\n${summary}`,
        );
      }

      if (isNtfyAvailable()) {
        const title =
          emails.length === 1
            ? `Email importante de ${emails[0].from.split('<')[0].trim() || 'remetente'}`
            : `${emails.length} emails importantes`;
        // sem await — não bloqueia o ciclo se ntfy demorar.
        void sendNtfy(summary, { title, priority: 'high', tags: ['email'] }).then(
          (r) => {
            if (r.ok) console.log('[email] ntfy enviado');
            else console.warn('[email] ntfy falhou:', r.reason);
          },
        );
      }
    },
  }),
  );

  // Poller de notificações ClickUp (a cada 5min — política da empresa não
  // permite webhooks). Cobre tasks atribuídas, comments e menções via
  // notifications API. Resumo agregado pro Gemini falar + widget.
  shutdownHandlers.push(
    startClickupNotificationsPoller({
    onBatch: (batch: NotificationsBatch) => {
      console.log(
        `[clickup-notif] batch: ${batch.items.length} item(s) — "${batch.summary}"`,
      );
      const liveReady = liveStateKind === 'ready' || liveStateKind === 'speaking';
      if (live && liveReady) {
        live.sendText(
          `[evento interno — não é fala do usuário] Notificações novas no ` +
            `ClickUp. Avise o usuário em UMA frase curta e natural usando ` +
            `EXATAMENTE o resumo abaixo (pode reformular um pouco mas não ` +
            `adicione detalhes nem chame tools).\n\n${batch.summary}`,
        );
      }
      // Widget — emite junto pra UI mostrar lista detalhada.
      const widgetId = randomUUID();
      emit({
        type: 'widget',
        id: widgetId,
        widget: {
          kind: 'notifications',
          source: 'clickup',
          items: batch.items,
        },
        ttlMs: 60_000 * 30, // 30min na tela
      });
    },
  }),
  );

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
        onWebhookEvent: (whEvent) => {
          handleWebhookEvent(whEvent);
        },
      });
      wsClient.connect();
    } else if (lastConn) {
      mainWindow?.webContents.send('assistant:event', lastConn);
    }
    emitTtsState();
    // Estado inicial do projeto ativo pra UI mostrar a label antes mesmo
    // de qualquer interação.
    emit({
      type: 'active_project',
      path: activeProjectCwd,
      name: activeProjectName,
    });
    // Pós-restart via tool restart_app: religa a Live sozinho. Aceita
    // sinal via argv (modo packageado) OU env (modo dev — o argv não
    // atravessa `npm run dev:desktop`).
    if (process.argv.includes('--auto-live') || process.env.PIXXEL_AUTO_LIVE === '1') {
      setTimeout(() => emit({ type: 'auto_start_live' }), 800);
    }
  });

  ipcMain.handle('assistant:send-text', (_event, text: string) => {
    wsClient?.sendText(text);
  });

  ipcMain.handle('assistant:memory-graph', () => {
    return memory?.graph() ?? { nodes: [], edges: [] };
  });

  ipcMain.on(
    'assistant:camera-frame',
    (_event, requestId: string, dataUrl: string | null) => {
      deliverFrame(requestId, dataUrl);
    },
  );

  ipcMain.handle(
    'assistant:instagram-publish',
    async (
      _event,
      fileBytes: ArrayBuffer,
      fileName: string,
      caption: string,
      shareToFeed: boolean = false,
    ): Promise<{ ok: boolean; reason?: string; permalink?: string }> => {
      const { isCloudinaryAvailable, uploadFile, destroyAsset } = await import(
        './integrations/cloudinary.js'
      );
      const { isInstagramAvailable, publishMedia } = await import(
        './integrations/instagram.js'
      );
      if (!isInstagramAvailable()) {
        return { ok: false, reason: 'INSTAGRAM_API_KEY não configurada' };
      }
      if (!isCloudinaryAvailable()) {
        return { ok: false, reason: 'Cloudinary não configurado (.env)' };
      }
      const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join: joinPath } = await import('node:path');
      const dir = await mkdtemp(joinPath(tmpdir(), 'pixxel-ig-'));
      const tmpPath = joinPath(dir, fileName);
      try {
        await writeFile(tmpPath, Buffer.from(fileBytes));
        const upload = await uploadFile(tmpPath);
        if (!upload) return { ok: false, reason: 'falha no upload Cloudinary' };
        try {
          const isVideo = upload.resourceType === 'video';
          const result = await publishMedia(upload.url, caption, isVideo, {
            shareToFeed: isVideo ? shareToFeed : undefined,
          });
          if (!result.ok) return { ok: false, reason: result.reason };
          return { ok: true, permalink: result.permalink };
        } finally {
          // Limpa do Cloudinary depois que IG já baixou.
          await destroyAsset(upload.publicId, upload.resourceType);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  registerFrameRequester((requestId) => {
    emit({ type: 'request_camera_frame', requestId });
  });

  // ===== Hand-mouse (controle do cursor por gestos) =====
  ipcMain.handle('assistant:hand-mouse-enable', async () => {
    const has = await isXdotoolAvailable();
    if (!has) return { ok: false, reason: 'xdotool não instalado' };
    const screenSize = getHandMouseScreenSize();
    return { ok: true, screen: screenSize };
  });
  ipcMain.handle('assistant:hand-mouse-disable', () => {
    stopHandMouse();
  });
  ipcMain.on('assistant:hand-mouse-move', (_e, x: number, y: number) => {
    moveMouseFast(x, y);
  });
  ipcMain.on('assistant:hand-mouse-click', (_e, button: 1 | 2 | 3) => {
    clickMouseFast(button);
  });
  ipcMain.on('assistant:hand-mouse-down', (_e, button: 1 | 2 | 3) => {
    mouseDownFast(button);
  });
  ipcMain.on('assistant:hand-mouse-up', (_e, button: 1 | 2 | 3) => {
    mouseUpFast(button);
  });
  ipcMain.on(
    'assistant:hand-mouse-scroll',
    (_e, direction: 'up' | 'down', ticks: number) => {
      scrollMouseFast(direction, ticks);
    },
  );

  // User clicou numa notificação ClickUp → pede pro Gemini explicar a task.
  // Tool clickup_explain_task já retorna texto pra fala + widget task-detail.
  ipcMain.on('assistant:explain-clickup-task', (_e, taskId: string) => {
    if (!live || !live.isOpen()) {
      console.warn('[ipc] explain-clickup-task: live não disponível');
      return;
    }
    const sanitized = String(taskId).replace(/[^A-Za-z0-9-]/g, '');
    if (!sanitized) return;
    live.sendText(
      `[evento interno — não é fala do usuário] Usuário clicou na notificação ` +
        `da task ${sanitized}. Use a tool clickup_explain_task com taskId="${sanitized}" ` +
        `e fale sobre a task de forma natural.`,
    );
  });

  ipcMain.on('assistant:window-close', () => mainWindow?.close());
  ipcMain.on('assistant:window-minimize', () => mainWindow?.minimize());
  ipcMain.on('assistant:window-maximize-toggle', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
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

  function scheduleLiveReconnect(): void {
    if (liveReconnectTimer) return; // já agendado
    if (!liveDesiredActive) return;
    const idx = Math.min(liveReconnectAttempt, LIVE_RECONNECT_DELAYS_MS.length - 1);
    const delay = LIVE_RECONNECT_DELAYS_MS[idx];
    liveReconnectAttempt += 1;
    console.warn(
      `[live] reconnect agendado em ${delay / 1000}s (tentativa ${liveReconnectAttempt})`,
    );
    liveReconnectTimer = setTimeout(() => {
      liveReconnectTimer = null;
      if (!liveDesiredActive) return;
      const r = startLiveSession();
      if (!r.ok) {
        console.warn(`[live] reconnect falhou: ${r.reason}`);
        scheduleLiveReconnect();
      }
    }, delay);
  }

  function cancelLiveReconnect(): void {
    if (liveReconnectTimer) {
      clearTimeout(liveReconnectTimer);
      liveReconnectTimer = null;
    }
    liveReconnectAttempt = 0;
  }

  function startLiveSession(): { ok: boolean; reason?: string } {
    if (!GEMINI_API_KEY) {
      const reason = 'GEMINI_API_KEY missing in .env';
      emit({ type: 'live_state', state: { kind: 'unavailable', reason } });
      return { ok: false, reason };
    }
    // Hardening: cliente vivo e saudável é idempotente. Mas se está pendurado
    // (ws stuck, setupDone false, etc), força cleanup antes de recriar.
    // Isso resolve o caso "preciso reiniciar o electron pra reconectar".
    if (live) {
      if (live.isOpen()) {
        return { ok: true };
      }
      console.warn('[live] cliente pendurado detectado, forçando cleanup');
      try {
        live.stop();
      } catch (err) {
        console.warn('[live] erro no stop forçado (ignorado):', err);
      }
      live = null;
    }
    // Reset da cinta do briefing — nova sessão pode ter briefing de novo.
    briefingHandledThisSession = false;
    // Widgets ficam pendentes até o primeiro chunk de áudio depois da tool call,
    // pra aparecerem em sincronia com a fala (não na hora que a integração
    // termina, que pode ser bem antes).
    const pendingWidgets: Array<{ id: string; widget: Widget; ttlMs: number }> = [];
    // Dedup de tool calls duplicadas. Gemini Live ocasionalmente dispara a
    // mesma tool com os mesmos args duas vezes em poucos ms (paralelismo
    // espúrio ou retry interno). Janela de 1.5s pelo nome+args.
    const recentCalls = new Map<string, { at: number; responded: boolean }>();
    const TOOL_DEDUP_MS = 1500;
    function isDuplicateCall(name: string, args: Record<string, unknown>): boolean {
      const key = `${name}:${JSON.stringify(args)}`;
      const now = Date.now();
      const prev = recentCalls.get(key);
      if (prev && now - prev.at < TOOL_DEDUP_MS) return true;
      recentCalls.set(key, { at: now, responded: false });
      for (const [k, v] of recentCalls) {
        if (now - v.at > TOOL_DEDUP_MS * 4) recentCalls.delete(k);
      }
      return false;
    }
    live = new GeminiLiveClient(
      GEMINI_API_KEY,
      {
        onState: (state) => {
          liveStateKind = state.kind;
          emit({ type: 'live_state', state });
          if (state.kind === 'ready') {
            // Flush das falas de webhook que chegaram durante boot/reconnect.
            // Pequeno delay pra dar prioridade pro briefing matinal se houver.
            setTimeout(() => flushPendingWebhookPhrases(), 500);
            // Briefing automático na primeira conexão Live do dia.
            // Verifica disco antes de disparar pra evitar duplicação se o user
            // já pediu manualmente nessa sessão.
            if (!briefingHandledThisSession) {
              void (async () => {
                try {
                  const firstToday = await isFirstBriefingOfDay();
                  if (!firstToday) return;
                  if (briefingHandledThisSession) return; // race guard
                  if (!live?.isOpen()) return;
                  // Pede pro Gemini chamar a tool — fluxo normal cuida do
                  // áudio, widgets e marcação de briefingHandledThisSession.
                  live.sendText(
                    'Use a tool morning_briefing agora pra me dar meu briefing.',
                  );
                } catch (err) {
                  console.warn('[live] auto-briefing falhou:', err);
                }
              })();
            }
          }
          if (state.kind === 'closed' || state.kind === 'error' || state.kind === 'idle') {
            live = null;
            // Se o usuário ainda quer Live ativo e a queda não foi um stop
            // manual, agenda reconnect. State 'idle' vem de stop() — pula.
            if (
              liveDesiredActive &&
              (state.kind === 'closed' || state.kind === 'error')
            ) {
              scheduleLiveReconnect();
            }
          }
          // Conexão estabelecida com sucesso — zera contador de retry.
          if (state.kind === 'ready') {
            liveReconnectAttempt = 0;
          }
        },
        onAudio: (pcm) => {
          // Flush widgets pendentes antes do primeiro chunk pra aparecerem
          // junto com o início da fala
          if (pendingWidgets.length > 0) {
            console.log(
              `[live] flushing ${pendingWidgets.length} pending widget(s) on audio chunk`,
            );
            for (const p of pendingWidgets) {
              if (p.widget)
                emit({ type: 'widget', id: p.id, widget: p.widget, ttlMs: p.ttlMs });
            }
            pendingWidgets.length = 0;
          }
          const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer;
          emit({ type: 'live_audio', pcm: ab, sampleRate: 24000 });
        },
        onTranscript: (text, role) => {
          emit({ type: 'live_transcript', role, text });

          // Guard: pergunta de estado sem chamar current_work_status.
          if (role === 'user') {
            const norm = text
              .toLowerCase()
              .normalize('NFD')
              .replace(/[̀-ͯ]/g, '');
            const stateQuestion =
              /\b(ta|esta|tem alguma|terminou|terminei|pronto|tem alguma coisa|no que|qual.*tarefa|tarefa atual|sessao|ainda|ja terminou|continua|fez|fizemos|criou|salvou)\b/.test(
                norm,
              ) &&
              (/\?/.test(text) ||
                /\b(rodando|em andamento|trabalh|fazendo|atual|ativ|aberto)\b/.test(norm));
            if (stateQuestion) {
              if (pendingStateCheck) clearTimeout(pendingStateCheck);
              const detectedAt = Date.now();
              pendingStateCheck = setTimeout(() => {
                pendingStateCheck = null;
                if (lastCurrentWorkStatusAtMs >= detectedAt) return;
                console.warn(
                  '[guard] usuário perguntou sobre estado mas Gemini não chamou current_work_status. Mandando lembrete.',
                );
                live?.sendText(
                  '[Sistema] O usuário acabou de perguntar sobre estado de ' +
                    'tarefa. Você NÃO chamou current_work_status — então NÃO ' +
                    'sabe a verdade. Chame current_work_status AGORA antes de ' +
                    'responder. Se já respondeu errado, corrija.',
                );
              }, 4000);
            }
          }
        },
        onToolCall: async (call) => {
          console.log('[live] tool call:', call.name, call.args);

          if (isDuplicateCall(call.name, call.args)) {
            console.warn(
              `[live] tool call DUPLICADA suprimida: ${call.name} (mesmos args em <${TOOL_DEDUP_MS}ms)`,
            );
            live?.sendToolResponse(call.id, call.name, {
              ok: true,
              text: '(chamada duplicada suprimida — use a resposta anterior)',
            });
            return;
          }

          // Caminho memória — vault markdown persistente em ~/pixxel/memory/.
          if (call.name === 'remember') {
            const args = {
              name: String(call.args.name ?? ''),
              type: String(call.args.type ?? '') as MemoryType,
              description: String(call.args.description ?? ''),
              content: String(call.args.content ?? ''),
              links: Array.isArray(call.args.links)
                ? (call.args.links as unknown[]).map(String)
                : [],
            };
            const r = await memory?.remember(args);
            if (r?.ok) {
              void indexMemoryEntry(args); // background, sem bloquear resposta
            }
            live?.sendToolResponse(call.id, call.name, {
              ok: r?.ok ?? false,
              text: r?.ok ? 'Anotado.' : undefined,
              reason: r?.reason,
            });
            return;
          }
          if (call.name === 'update_memory') {
            const name = String(call.args.name ?? '');
            const r = await memory?.update({
              name,
              description:
                call.args.description !== undefined ? String(call.args.description) : undefined,
              content: call.args.content !== undefined ? String(call.args.content) : undefined,
              links: Array.isArray(call.args.links)
                ? (call.args.links as unknown[]).map(String)
                : undefined,
            });
            if (r?.ok) {
              // Re-index — busca o entry atualizado direto do vault.
              const e = memory?.get?.(name);
              if (e) {
                void indexMemoryEntry({
                  name: e.name,
                  type: e.type,
                  description: e.description,
                  content: e.content,
                });
              }
            }
            live?.sendToolResponse(call.id, call.name, {
              ok: r?.ok ?? false,
              text: r?.ok ? 'Atualizado.' : undefined,
              reason: r?.reason,
            });
            return;
          }
          if (call.name === 'forget_memory') {
            const name = String(call.args.name ?? '');
            const r = await memory?.forget(name);
            if (r?.ok) void unindexMemoryEntry(name);
            live?.sendToolResponse(call.id, call.name, {
              ok: r?.ok ?? false,
              text: r?.ok ? 'Esqueci.' : undefined,
              reason: r?.reason,
            });
            return;
          }

          // Cinta de segurança do briefing: máximo 1 por sessão Live.
          if (call.name === 'morning_briefing' && briefingHandledThisSession) {
            console.log('[live] morning_briefing bloqueado — já rodou nesta sessão');
            live?.sendToolResponse(call.id, call.name, {
              ok: false,
              reason: 'Briefing já foi feito nesta sessão',
            });
            return;
          }

          // Caminho ideas tools (save_idea, plan_feature) — anexa em IDEIAS.md.
          if (IDEAS_TOOL_NAMES.has(call.name)) {
            const title = String(call.args.title ?? '').trim();
            const description = String(call.args.description ?? '').trim();
            if (!title || !description) {
              live?.sendToolResponse(call.id, call.name, {
                ok: false,
                reason: 'título e descrição são obrigatórios',
              });
              return;
            }
            if (call.name === 'save_idea') {
              const res = await saveIdea({ title, description });
              live?.sendToolResponse(call.id, call.name, res.ok
                ? { ok: true, text: `Anotei "${title}" em IDEIAS.md.` }
                : { ok: false, reason: res.reason });
              return;
            }
            if (call.name === 'plan_feature') {
              const plan = String(call.args.plan ?? '').trim();
              if (!plan) {
                live?.sendToolResponse(call.id, call.name, {
                  ok: false,
                  reason: 'plano vazio — Gemini precisa elaborar o plano técnico',
                });
                return;
              }
              const saved = await saveIdea({ title, description, plan });
              live?.sendToolResponse(call.id, call.name, saved.ok
                ? { ok: true, text: `Plano de "${title}" salvo em IDEIAS.md.` }
                : { ok: false, reason: saved.reason });
              return;
            }
          }

          // Caminho 0.5: UI tools (open_chat) — só emite evento pro renderer
          // mostrar/esconder painel; não tem ClientCommand nem integração.
          if (UI_TOOL_NAMES.has(call.name)) {
            if (call.name === 'open_chat') {
              const open = call.args.open === undefined ? true : Boolean(call.args.open);
              emit({ type: 'ui_panel', panel: 'chat', open });
              live?.sendToolResponse(call.id, call.name, {
                ok: true,
                text: open ? 'Chat aberto.' : 'Chat fechado.',
              });
              return;
            }
            if (call.name === 'show_memory') {
              const open = call.args.open === undefined ? true : Boolean(call.args.open);
              emit({ type: 'ui_panel', panel: 'memory_graph', open });
              live?.sendToolResponse(call.id, call.name, { ok: true });
              return;
            }
            if (call.name === 'open_camera') {
              const open = call.args.open === undefined ? true : Boolean(call.args.open);
              emit({ type: 'ui_panel', panel: 'camera', open });
              live?.sendToolResponse(call.id, call.name, {
                ok: true,
                text: open ? 'Câmera aberta.' : 'Câmera fechada.',
              });
              return;
            }
          }

          // test_desktop_control: teste curto e isolado de mouse/teclado.
          if (call.name === 'test_desktop_control') {
            live?.sendToolResponse(call.id, call.name, {
              ok: true,
              text:
                'Teste de mouse e teclado iniciado. Observa o cursor — vou ' +
                'desenhar na tela e depois digitar onde o foco estiver. Esc ' +
                'cancela.',
            });
            void (async () => {
              const { runMouseKeyboardTest } = await import(
                './integrations/presentation.js'
              );
              const r = await runMouseKeyboardTest({ live, emit });
              console.log(
                `[demo-mk] fim — completed=${r.completed} ok=${r.ok}${r.reason ? ' reason=' + r.reason : ''}`,
              );
            })();
            return;
          }

          // start_presentation: roda script de demo em background. Responde
          // imediato pra o Live falar "ok, começando" e prossegue async. Esc
          // ou tool de cancel interrompem.
          if (call.name === 'start_presentation') {
            live?.sendToolResponse(call.id, call.name, {
              ok: true,
              text:
                'Apresentação iniciada. Vou narrar e operar o app sozinho. ' +
                'Aperta Esc se quiser parar.',
            });
            void (async () => {
              const { runPresentation } = await import(
                './integrations/presentation.js'
              );
              const r = await runPresentation({ live, emit });
              console.log(
                `[presentation] fim — completed=${r.completed} ok=${r.ok}${r.reason ? ' reason=' + r.reason : ''}`,
              );
            })();
            return;
          }

          // restart_app — reinicia Electron preservando intenção de Live.
          // Manda o response, dá um respiro pro Gemini falar a frase de aviso,
          // e relança com flag `--auto-live` pro novo processo religar a
          // sessão automaticamente.
          if (call.name === 'restart_app') {
            live?.sendToolResponse(call.id, call.name, {
              ok: true,
              text: 'Reiniciando agora — já volto e reconecto sozinho.',
            });
            const finishRestart = () => {
              if (app.isPackaged) {
                // Build packageado: app.relaunch funciona normal — o execPath
                // é o binário final do app, sem electron-vite no caminho.
                const baseArgs = process.argv
                  .slice(1)
                  .filter((a) => a !== '--auto-live');
                app.relaunch({ args: [...baseArgs, '--auto-live'] });
                app.exit(0);
                return;
              }
              // Dev: rodando via `electron-vite dev`. app.relaunch lança o
              // electron solto, fora do dev server, e mata o terminal pai.
              // Em vez disso, sobe um `npm run dev:desktop` detached com
              // sleep de 2s pra dar tempo do processo atual morrer e o
              // electron-vite anterior liberar a porta do vite. Sinaliza
              // intenção de auto-live via env (já que --argv não sobrevive
              // ao npm script).
              const repoRoot = pathResolve(app.getAppPath(), '..', '..');
              const env = { ...process.env };
              env.PIXXEL_AUTO_LIVE = '1';
              try {
                const child = spawn(
                  'sh',
                  ['-c', `sleep 2; cd "${repoRoot}" && npm run dev:desktop`],
                  { detached: true, stdio: 'ignore', env },
                );
                child.unref();
              } catch (err) {
                console.warn('[restart_app] falha ao spawnar dev:desktop:', err);
              }
              app.exit(0);
            };
            setTimeout(finishRestart, 1500);
            return;
          }

          // Marca chamada de current_work_status — cancela reminder pendente
          // do guard (Gemini consultou estado, não vai alucinar).
          if (call.name === 'current_work_status') {
            lastCurrentWorkStatusAtMs = Date.now();
            if (pendingStateCheck) {
              clearTimeout(pendingStateCheck);
              pendingStateCheck = null;
            }
          }

          // Caminho 1: integrações (weather, clickup_*, play_youtube, open_project, morning_briefing)
          if (INTEGRATION_NAMES.has(call.name)) {
            const intRes = await executeIntegration(call.name, call.args);
            if (intRes) {
              if (intRes.ok) {
                // Coleta widget único + lista (briefing usa lista pra mostrar
                // clima + tasks juntos). Enfileirados pra aparecerem em
                // sincronia com o áudio.
                const allWidgets: Widget[] = [];
                const allDelays: number[] = [];
                if (intRes.widget) {
                  allWidgets.push(intRes.widget);
                  allDelays.push(0);
                }
                if (intRes.widgets) {
                  for (let i = 0; i < intRes.widgets.length; i++) {
                    allWidgets.push(intRes.widgets[i]);
                    allDelays.push(intRes.widgetDelaysMs?.[i] ?? 0);
                  }
                }
                for (let i = 0; i < allWidgets.length; i++) {
                  const w = allWidgets[i];
                  const delayMs = allDelays[i];
                  const id = randomUUID();
                  const ttlMs = ttlForWidget(w.kind);
                  if (delayMs > 0) {
                    // Widgets atrasados não passam pela fila de áudio: emite
                    // direto após o delay (a fala já começou nesse ponto).
                    setTimeout(() => {
                      emit({ type: 'widget', id, widget: w, ttlMs });
                    }, delayMs);
                  } else {
                    pendingWidgets.push({ id, widget: w, ttlMs });
                  }
                }
                if (allWidgets.length > 0) {
                  console.log(
                    `[live] ${allWidgets.length} widget(s) enfileirado(s) (${call.name}). pending=${pendingWidgets.length}`,
                  );
                } else {
                  console.log(`[live] tool ${call.name} sem widget`);
                }
              }
              // open_project bem sucedido → marca como projeto ativo.
              if (
                call.name === 'open_project' &&
                intRes.ok &&
                typeof intRes.meta?.projectPath === 'string'
              ) {
                const projectPath = intRes.meta.projectPath;
                const projectName = typeof intRes.meta.projectName === 'string'
                  ? intRes.meta.projectName
                  : null;
                setActiveProject(projectPath, projectName);
              }
              if (call.name === 'morning_briefing' && intRes.ok) {
                briefingHandledThisSession = true;
                // Persiste cross-session: hoje já teve briefing, próximas vezes
                // que o app abrir hoje não disparam de novo.
                void markBriefingDoneToday();
              }
              // Strip widget/widgets antes de mandar pro Gemini — eles são pra
              // UI (já enfileirados acima), não pro modelo. Mandar widget cheio
              // de JSON infla contexto a cada turno e pode causar close 1008.
              const slim: Record<string, unknown> = intRes.ok
                ? { ok: true, text: intRes.text, ...(intRes.meta ? { meta: intRes.meta } : {}) }
                : {
                    ok: false,
                    reason: intRes.reason,
                    ...(intRes.text ? { text: intRes.text } : {}),
                  };
              live?.sendToolResponse(call.id, call.name, slim);
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
      {
        model: GEMINI_LIVE_MODEL,
        tools: ALL_TOOLS,
        extraSystemInstruction:
          (memory?.formatForPrompt() ?? '') +
          (getStudyPlanStore().formatForPrompt() ?? ''),
      },
    );
    live.start();
    return { ok: true };
  }

  ipcMain.handle('assistant:live-start', () => {
    liveDesiredActive = true;
    cancelLiveReconnect();
    return startLiveSession();
  });

  // Auto-start: conecta no Live só depois que o renderer terminou de carregar
  // (pra UI receber os live_state events). did-finish-load pode disparar de
  // novo em reloads — flag evita reconexão dupla.
  let liveAutoStarted = false;
  mainWindow?.webContents.on('did-finish-load', () => {
    if (liveAutoStarted) return;
    liveAutoStarted = true;
    // Pequeno delay pra dar tempo do renderer registrar `onEvent` listener
    // (preload sim, React precisa montar). 300ms é imperceptível.
    setTimeout(() => {
      liveDesiredActive = true;
      const r = startLiveSession();
      if (!r.ok) console.warn('[live] auto-start falhou:', r.reason);
      else console.log('[live] auto-start disparado');
    }, 300);
  });

  ipcMain.handle('assistant:live-stop', () => {
    liveDesiredActive = false;
    cancelLiveReconnect();
    live?.stop();
    live = null;
    emit({ type: 'live_state', state: { kind: 'idle' } });
  });

  ipcMain.on('assistant:live-audio', (_event, pcm16k: ArrayBuffer) => {
    if (!live) return;
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

// Hook usado pelo handler da tool `restart_app` (escopo integrations).
// Encerra tudo limpo e relança o app — funciona com `npm run dev` também
// (electron-vite reabre quando o main process é relaunched).
(globalThis as { __pixxelRestart?: () => void }).__pixxelRestart = () => {
  console.log('[restart] disparado via tool — relaunching');
  shutdownAll();
  app.relaunch();
  app.exit(0);
};

function shutdownAll(): void {
  // Cancela todos pollers (sysmetrics, netbw, top-procs, wifi, email,
  // clickup-notif). Sem isso, setIntervals continuam disparando após
  // a janela morrer e batem em webContents destruído.
  for (const cancel of shutdownHandlers) {
    try {
      cancel();
    } catch (err) {
      console.warn('[shutdown] handler falhou:', err);
    }
  }
  shutdownHandlers.length = 0;
  wsClient?.close();
  tts?.cancel();
  live?.stop();
  // Cancela reconnect agendado (cancelLiveReconnect é local a whenReady).
  if (liveReconnectTimer) {
    clearTimeout(liveReconnectTimer);
    liveReconnectTimer = null;
  }
  liveDesiredActive = false;
  stopHandMouse();
}

app.on('window-all-closed', () => {
  shutdownAll();
  if (process.platform !== 'darwin') {
    // app.quit() aguarda before-quit/will-quit e pode ficar pendurado se
    // alguma promise async (ws Gemini Live, IMAP, child process) segurar
    // o event loop. Fallback: força exit em 1s se ainda estiver vivo.
    app.quit();
    setTimeout(() => {
      console.warn('[shutdown] app.quit não completou, forçando exit');
      app.exit(0);
    }, 1000);
  }
});

// Belt-and-suspenders: se app.quit() for chamado por outro caminho (Cmd+Q,
// SIGTERM, etc) sem passar por window-all-closed, ainda fechamos tudo.
app.on('before-quit', () => {
  shutdownAll();
});
