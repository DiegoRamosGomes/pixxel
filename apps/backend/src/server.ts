// config primeiro: carrega o .env antes dos módulos que leem process.env no
// import (ex.: pastas de dados resolvidas em constantes de módulo).
import { config } from './config.js';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { getStorageStatus, getSystemSnapshot } from '@assistant/metrics';
import { logger } from './logger.js';
import { handleConnection } from './ws/handler.js';
import { registerExpoWebhook } from './webhooks/expo.js';
import { registerHttpRoutes } from './http/routes.js';
import { markWebhookDelivered, purgeOldDelivered } from './memory/db.js';
import { ClientRegistry, type ConnectedClient, type LiveRecoveryContext } from './clients/client-registry.js';
import { NoticeDispatcher } from './notices/notice-dispatcher.js';
import { startJobs } from './jobs.js';
import { MemoryVault } from './vault/memory-vault.js';
import { GeminiLiveClient } from './voice/gemini-live.js';
import { VoiceSession } from './voice/voice-session.js';
import { toolsForClient } from './voice/tool-catalog.js';
import { createToolExecutor } from './voice/tool-executor.js';
import {
  cancelPresentation,
  runMouseKeyboardTest,
  runPresentation,
  type PresentationCtx,
} from './voice/presentation.js';
import { executeIntegration } from './integrations/index.js';
import { lookAtCamera } from './integrations/vision.js';
import { saveIdea } from './integrations/ideas.js';
import { indexMemoryEntry, unindexMemoryEntry } from './integrations/embeddings.js';
import { isFirstBriefingOfDay, markBriefingDoneToday } from './integrations/briefing.js';
import { getStudyPlanStore } from './integrations/study-plans.js';
import { isNtfyAvailable, sendNtfy } from './integrations/email/notifier.js';
import { publishInstagramFile } from './integrations/instagram-publish.js';

const memory = new MemoryVault();
await memory.load();

const registry = new ClientRegistry();

const notices = new NoticeDispatcher({
  registry,
  sendPush: async (p) => {
    if (!isNtfyAvailable()) return;
    const r = await sendNtfy(p.body, { title: p.title, priority: p.priority, tags: p.tags });
    if (!r.ok) logger.warn({ reason: r.reason }, 'ntfy falhou');
  },
  markExpoDelivered: markWebhookDelivered,
});

function createSession(client: ConnectedClient, recovery: LiveRecoveryContext | undefined): VoiceSession {
  const local: PresentationCtx['local'] = (op, args) => client.bridge.call(op, args);
  const presentationCtx: PresentationCtx = {
    say: (text) => {
      session.sendInternal(text);
    },
    local,
    showWidget: (widget, ttlMs) => {
      const id = randomUUID();
      client.send({ type: 'widget', id, widget, ttlMs });
      return id;
    },
    dismissWidget: (id) => client.send({ type: 'widget_dismiss', id }),
  };

  const executeTool = createToolExecutor({
    localOps: client.localOps,
    local,
    runIntegration: executeIntegration,
    memory,
    memoryIndex: {
      add: (e) => void indexMemoryEntry(e),
      remove: (name) => void unindexMemoryEntry(name),
    },
    saveIdea,
    lookAtCamera,
    serverSnapshot: getSystemSnapshot,
    serverStorage: getStorageStatus,
    presentation: {
      start: () => void runPresentation(presentationCtx),
      startMouseKeyboardTest: () => void runMouseKeyboardTest(presentationCtx),
    },
    markBriefingDone: markBriefingDoneToday,
  });

  const session: VoiceSession = new VoiceSession({
    createLive: (listeners, options) =>
      new GeminiLiveClient(config.GEMINI_API_KEY ?? '', listeners, {
        ...options,
        model: config.GEMINI_LIVE_MODEL,
      }),
    unavailableReason: config.GEMINI_API_KEY ? undefined : 'GEMINI_API_KEY ausente no servidor',
    tools: toolsForClient(client.localOps),
    extraSystemInstruction: () =>
      memory.formatForPrompt() +
      getStudyPlanStore().formatForPrompt() +
      `\n\nDISPOSITIVO ATUAL: ${client.kind}.`,
    executeTool,
    sink: {
      state: (state) => {
        logger.info({ clientId: client.clientId, state: state.kind }, 'voice state');
        client.send({ type: 'voice_state', state });
      },
      audio: (pcm) => client.sendAudio(pcm),
      transcript: (role, text) => client.send({ type: 'transcript', role, text }),
      widget: (w) => client.send({ type: 'widget', ...w }),
    },
    isFirstBriefingOfDay,
    onReady: () => notices.onSessionReady(),
    onUserActivity: () => registry.touch(client.clientId),
    recovery,
  });
  return session;
}

const app = Fastify({ loggerInstance: logger });

await app.register(websocket);

// Health check pra proxy / monitoring.
app.get('/health', async () => ({ status: 'ok' }));

// Webhook Expo (HMAC SHA-1 via header expo-signature).
registerExpoWebhook(app, (row) => notices.enqueueExpo(row));

registerHttpRoutes(app, {
  token: config.CLIENT_TOKEN,
  memoryGraph: () => memory.graph(),
  publishInstagram: publishInstagramFile,
});

// WebSocket dos clientes (auth via hello + token).
app.get('/ws', { websocket: true }, (socket) => {
  handleConnection(socket, {
    token: config.CLIENT_TOKEN,
    registry,
    localToolTimeoutMs: config.LOCAL_TOOL_TIMEOUT_MS,
    createSession,
    onPresentationAbort: cancelPresentation,
  });
});

// Limpeza periódica: webhook events entregues há mais de 30 dias somem.
setInterval(() => purgeOldDelivered(30), 24 * 60 * 60 * 1000);

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, host: config.HOST }, 'pixxel-backend listening');
} catch (err) {
  logger.error({ err }, 'failed to start');
  process.exit(1);
}

const stopJobs = await startJobs({ memory, notices });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    logger.info({ signal }, 'encerrando');
    stopJobs();
    void app.close().finally(() => process.exit(0));
  });
}
