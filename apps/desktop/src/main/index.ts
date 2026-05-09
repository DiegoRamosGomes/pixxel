import 'dotenv/config';
import { app, BrowserWindow, Menu, globalShortcut, ipcMain, session } from 'electron';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssistantWsClient } from './ws-client.js';
import type { ClaudePermissionRequest, RendererEvent } from '../shared/ipc.js';
import { isTtsAvailable, TtsEngine } from './voice/tts.js';
import { SentenceBuffer } from './voice/sentence-buffer.js';
import { GeminiLiveClient } from './voice/gemini-live.js';
import {
  ALL_TOOLS,
  UI_TOOL_NAMES,
  IDEAS_TOOL_NAMES,
  CLAUDE_CONTROL_TOOL_NAMES,
} from './voice/tool-declarations.js';
import { saveIdea, IDEAS_FILE_PATH } from './integrations/ideas.js';
import {
  getStudyPlanStore,
  seedKamilaPlanIfMissing,
  applyKamilaCuratedVideos,
} from './integrations/study-plans.js';
import { getActiveWorkStore } from './integrations/active-work.js';
import { executeCommand } from './executor.js';
import { executeIntegration, INTEGRATION_NAMES } from './integrations/index.js';
import {
  clearPendingTest,
  readPendingTest,
  savePendingTest,
} from './integrations/pending-test.js';
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
import { findProject } from './integrations/projects.js';
import { ClientCommandSchema } from '@assistant/shared';
import { randomUUID } from 'node:crypto';
import { resolve as pathResolve } from 'node:path';
import { spawn } from 'node:child_process';
import type { Widget } from '../shared/widgets.js';
import { ClaudeRunner } from './claude/runner.js';
import { WorkLog, type WorkLogSource } from './work-log.js';
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
import { ClaudeUsageService, setActiveClaudeUsageService } from './services/claude-usage.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// Diretório onde o `claude -p` vai operar. Default: raiz do monorepo deste
// projeto (subindo de apps/desktop/out/main). Override via CLAUDE_PROJECT_DIR.
// Vira mutável: depois de open_project ou claude_code_task com `project`,
// esse alvo passa a ser o projeto resolvido, e claude_code_task subsequentes
// rodam lá.
const DEFAULT_CLAUDE_PROJECT_DIR =
  process.env.CLAUDE_PROJECT_DIR ?? pathResolve(__dirname, '../../../..');
let activeClaudeCwd = DEFAULT_CLAUDE_PROJECT_DIR;
let activeClaudeProjectName: string | null = null;

function setActiveProject(path: string, name: string | null): void {
  if (path === activeClaudeCwd && name === activeClaudeProjectName) return;
  activeClaudeCwd = path;
  activeClaudeProjectName = name;
  console.log(`[claude] projeto ativo: ${name ?? '(default)'} ${path}`);
  emit({ type: 'claude_active_project', path, name });
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
let claude: ClaudeRunner | null = null;
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
// Fila de tarefas Claude pendentes — tarefas que chegaram enquanto outra
// rodava. Disparadas em ordem assim que a anterior termina.
type QueuedClaudeTask = {
  task: string;
  cwd: string;
  projectName: string | null;
  source: WorkLogSource;
};
const MAX_CLAUDE_QUEUE = 5;
const claudeQueue: QueuedClaudeTask[] = [];
// Flag pro onResult saber se a parada foi via cancel manual (vira interrupted)
// ou erro técnico (vira failed). Reset no início da próxima run.
let claudeCancelInProgress = false;
// Timestamp do último claude_permission_decide processado. Usado pra dedupe:
// Gemini às vezes redispatcha claude_code_task junto com o permission grant
// (BUG do modelo), criando tarefa duplicada na fila. Janela curta de 5s
// detecta e descarta o duplo dispatch.
let lastPermissionGrantAtMs = 0;
const PERMISSION_GRANT_DEDUPE_MS = 5_000;
// Detecção de "Gemini falou que vai fazer algo mas não chamou claude_code_task".
// Quando user transcript matchar gatilho de código, agendamos um check em 6s.
// Se nesse intervalo claude_code_task NÃO foi chamada, injeta um lembrete.
let pendingDispatchCheck: NodeJS.Timeout | null = null;
let lastClaudeCodeTaskAtMs = 0;
// Detecção de "Gemini hallucina sobre estado". Quando user transcript matchar
// uma pergunta de estado, força chamada antecipada de current_work_status
// se Gemini não chamou em 4s.
let pendingStateCheck: NodeJS.Timeout | null = null;
let lastCurrentWorkStatusAtMs = 0;

function emitClaudeQueue(): void {
  emit({ type: 'claude_queue', tasks: claudeQueue.map((q) => q.task) });
}

// Guard pra não dispachar a validação automática mais de uma vez por boot
// (live pode oscilar ready→speaking→ready durante a sessão).
let autoTestDispatched = false;

/**
 * Lê o pending-test.json salvo antes do restart, dispacha um claude_code_task
 * pra validar a alteração, e apaga o arquivo. Resultado do Claude flui pelo
 * onResult normal — Gemini comenta em primeira pessoa o sucesso/falha.
 */
async function runPendingAutoTest(): Promise<void> {
  const pending = await readPendingTest();
  if (!pending) {
    console.log('[auto-test] --auto-test setado mas pending-test.json não achado');
    return;
  }
  console.log(
    `[auto-test] dispachando validação no projeto ${pending.projectName ?? pending.projectPath}`,
  );
  // Apaga já — se Claude falhar, melhor não re-rodar no próximo boot.
  await clearPendingTest().catch(() => {});

  // Atualiza projeto ativo pra apontar pro mesmo onde a alteração foi feita.
  setActiveProject(pending.projectPath, pending.projectName);

  const prompt =
    `[Validação automática pós-restart] O assistente acabou de reiniciar pra ` +
    `aplicar uma alteração de código que VOCÊ fez. Agora precisa VALIDAR que ` +
    `está funcionando.\n\n` +
    `Plano de teste:\n${pending.testPlan}\n\n` +
    `Execute na ordem:\n` +
    `1) Rode typecheck no escopo afetado (ex: \`npx tsc --noEmit -p ` +
    `apps/desktop/tsconfig.json\`). Ignore erros que JÁ existiam antes da ` +
    `alteração — só reporte erros novos relacionados ao que mudou.\n` +
    `2) Se o plano mencionar testes (unit/e2e), rode-os.\n` +
    `3) Quaisquer verificações manuais descritas no plano (ex: grep por ` +
    `símbolo, ler arquivo X linha Y).\n` +
    `4) Reporte em 1-3 frases: ✅ sucesso (o que validou) OU ❌ falha (o que ` +
    `quebrou e onde). Seja específico, cite arquivo:linha quando relevante.\n\n` +
    `NÃO altere nada — apenas valide. NÃO chame restart_app de novo.`;

  const r = await enqueueOrStartClaudeTask({
    task: prompt,
    cwd: pending.projectPath,
    projectName: pending.projectName,
    source: 'voice',
  });
  if ('error' in r) {
    announceWhenLiveIdle(
      `[Sistema] Não consegui dispachar a validação automática: ${r.error}. ` +
        `Avise o usuário em primeira pessoa que o restart funcionou mas o teste ` +
        `não rodou.`,
    );
  } else if ('conflict' in r) {
    announceWhenLiveIdle(
      `[Sistema] Validação automática não rodou — tem outra sessão aberta ` +
        `("${r.current.description}"). Avise o usuário em primeira pessoa.`,
    );
  }
}

/**
 * Decide entre iniciar o Claude já ou enfileirar. Caminho ÚNICO pra ambos
 * voz e chat — evita race entre filas paralelas.
 *
 * Retorna `{started}` se start retornou ok (running). `{queued, position}`
 * se enfileirou. `{error}` se a fila estourou ou start falhou na hora
 * (ex: spawn imediato deu ruim, runner indisponível).
 */
async function enqueueOrStartClaudeTask(input: {
  task: string;
  cwd: string;
  projectName: string | null;
  source: WorkLogSource;
}): Promise<
  | { started: true }
  | { queued: true; position: number }
  | { conflict: 'session_open'; current: { description: string; kind: string; age: string } }
  | { error: string }
> {
  if (!claude) return { error: 'runner_not_ready' };
  if (claude.isRunning()) {
    if (claudeQueue.length >= MAX_CLAUDE_QUEUE) {
      return { error: `Fila cheia (${MAX_CLAUDE_QUEUE} tarefas).` };
    }
    claudeQueue.push(input);
    emitClaudeQueue();
    console.log(
      `[claude] enfileirado (pos ${claudeQueue.length}): "${input.task.slice(0, 80)}"`,
    );
    return { queued: true, position: claudeQueue.length };
  }

  // Detecta conflito com active-work running. Reflete a regra "uma sessão por
  // vez": se tem manual aberta, usuário precisa pausar/interromper antes.
  const aw = getActiveWorkStore();
  const openWork = aw.current();
  if (openWork) {
    const ageMs = Date.now() - new Date(openWork.startedAt).getTime();
    const min = Math.floor(ageMs / 60_000);
    const ageStr = min < 60 ? `${min}min atrás` : `${Math.floor(min / 60)}h atrás`;
    console.log(
      `[active-work] conflito ao iniciar code task — running: "${openWork.description}" (${openWork.kind ?? 'manual'})`,
    );
    return {
      conflict: 'session_open',
      current: {
        description: openWork.description,
        kind: openWork.kind ?? 'manual',
        age: ageStr,
      },
    };
  }

  console.log(`[claude] start cwd=${input.cwd} task="${input.task.slice(0, 80)}"`);
  // Cria entry em active-work logo de cara — kind=code. Se start falhar
  // depois, marcamos como failed na callback de erro.
  await aw
    .startWork({
      description: input.task,
      kind: 'code',
      cwd: input.cwd,
      projectName: input.projectName ?? undefined,
    })
    .catch((err) => console.warn('[active-work] startWork falhou:', err));

  // workLog em paralelo — não bloqueia o spawn. Tool events só chegam depois
  // do spawn estabilizar, então o session vai estar pronto a tempo.
  void workLog
    .startSession({
      project: input.cwd,
      projectName: input.projectName,
      task: input.task,
      source: input.source,
    })
    .catch((err) => console.warn('[work-log] startSession falhou:', err));
  const result = await claude.start({ prompt: input.task, cwd: input.cwd });
  if (!result.ok) {
    console.warn(`[claude] start falhou: ${result.reason}`);
    // Não conseguiu spawnar — fecha a entry como failed pra não ficar zumbi.
    void aw.markFailed(result.reason ?? 'falha desconhecida ao iniciar');
    return { error: result.reason ?? 'falha desconhecida ao iniciar' };
  }
  return { started: true };
}

function tryDequeueClaudeTask(): void {
  if (!claude || claude.isRunning()) return;
  const next = claudeQueue.shift();
  if (!next) return;
  emitClaudeQueue();
  console.log(
    `[claude] iniciando próxima da fila (${claudeQueue.length} restantes): "${next.task.slice(0, 80)}"`,
  );
  // Pequeno respiro pra cleanup do anterior fechar MCP/proc antes do novo subir.
  setTimeout(async () => {
    // Cria entry em active-work pra essa task da fila — sem isso, current_work_status
    // reportaria nada enquanto o Claude executa, e o callback de result não tem
    // o que fechar. Mesmo padrão do startClaudeCodeTask na primeira task.
    const aw = getActiveWorkStore();
    await aw
      .startWork({
        description: next.task,
        kind: 'code',
        cwd: next.cwd,
        projectName: next.projectName ?? undefined,
      })
      .catch((err) => console.warn('[active-work] startWork falhou:', err));
    void workLog
      .startSession({
        project: next.cwd,
        projectName: next.projectName,
        task: next.task,
        source: next.source,
      })
      .catch((err) => console.warn('[work-log] startSession falhou:', err));
    const r = await claude?.start({ prompt: next.task, cwd: next.cwd });
    if (r && !r.ok) {
      console.warn(`[claude] tarefa da fila falhou ao iniciar: ${r.reason}`);
      // Spawn falhou — fecha a entry pra não virar zumbi.
      void aw.markFailed(r.reason ?? 'falha desconhecida ao iniciar');
      announceWhenLiveIdle(
        `[Sistema] Não consegui iniciar a próxima tarefa da fila: ${r.reason}. Avise o usuário em primeira pessoa.`,
      );
      // Tenta a próxima da fila se houver — não fica preso por causa de uma.
      tryDequeueClaudeTask();
    }
  }, 500);
}
// Estado atual do Gemini Live, espelhado em main pra decidir se anúncios
// async (ex: resultado do Claude) podem ir agora ou precisam enfileirar.
let liveStateKind: 'idle' | 'connecting' | 'ready' | 'speaking' | 'unavailable' | 'error' | 'closed' = 'idle';
// Mensagem do Claude esperando Gemini parar de falar pra ser anunciada.
let pendingClaudeAnnouncement: string | null = null;

function announceWhenLiveIdle(note: string): void {
  // Se Gemini não tá ativo agora, nem enfileira.
  if (!live) return;
  if (liveStateKind === 'speaking' || liveStateKind === 'connecting') {
    pendingClaudeAnnouncement = note;
    console.log('[claude] anúncio enfileirado — gemini ocupado');
    return;
  }
  live.sendText(note);
}

function flushPendingAnnouncement(): void {
  if (!pendingClaudeAnnouncement || !live) return;
  const note = pendingClaudeAnnouncement;
  pendingClaudeAnnouncement = null;
  // Pequeno delay pra dar respiro entre fim do turno e novo input — sem
  // isso vi casos do Gemini cortar a transição.
  setTimeout(() => live?.sendText(note), 300);
}
let claudeUsage: ClaudeUsageService | null = null;
// Work log: registra cada sessão de Claude (início, progresso, fim) num
// arquivo .md em ~/pixxel/work-log/. Usado pra reler depois "como fiz X".
const workLog = new WorkLog();
// Último pedido de permissão do Claude ainda não respondido. Permite Gemini
// repassar a decisão do usuário (sim/não por voz) sem precisar do requestId.
let pendingClaudePermission: ClaudePermissionRequest | null = null;
// Timer do fallback: se o usuário falou sim/não claro e o Gemini não chamou
// `claude_permission_decide` em ~3s, o main resolve sozinho. Cobre o caso do
// Gemini verbalizar "negado" sem disparar a tool.
let permissionFallbackTimer: NodeJS.Timeout | null = null;
// Debounce dos anúncios pro Gemini quando o Claude faz várias permissões em
// sequência (ex: 3 Edits no mesmo arquivo). Sem isso, Gemini perguntaria 3×
// a mesma coisa. Última resposta de voz vale pra todas as pendentes seguintes.
let lastPermissionAnnounceMs = 0;
const PERMISSION_ANNOUNCE_DEBOUNCE_MS = 8000;
// Se o usuário autorizou recentemente uma tool, libera as próximas do mesmo
// tipo automaticamente até `until`. Cobre cenário "Claude tá fazendo várias
// edições no mesmo arquivo, autorizei uma → autoriza tudo dessa rodada".
let autoAllowMode: { until: number; tools: Set<string> } | null = null;
const AUTO_ALLOW_WINDOW_MS = 45_000;

function clearPermissionFallback(): void {
  if (permissionFallbackTimer) {
    clearTimeout(permissionFallbackTimer);
    permissionFallbackTimer = null;
  }
}

function detectPermissionAnswer(text: string, role: 'user' | 'model'): 'yes' | 'no' | null {
  // Normaliza acentos e pontuação. Casa palavras curtas comuns por voz.
  const t = text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s]/g, ' ')
    .trim();
  if (!t) return null;
  if (role === 'model') {
    // Gemini disse "negado/autorizado" como confirmação. Se não chamou a tool
    // junto, o fallback resolve sozinho com base nesse sinal.
    if (/\b(negad|nego|nega o pedido|nao autoriz|nao permit|rejeit)\w*\b/.test(t)) {
      return 'no';
    }
    if (/\b(autorizad|autorizo|autorizar|liberad|liberei|permit|pode seguir|pode ir)\w*\b/.test(t)) {
      return 'yes';
    }
    return null;
  }
  // role === 'user'. Padrões de "não" antes do "sim" pra "não" ganhar.
  if (/\b(nao|nega|rejeit|nem pensar|para com isso|espera|cancela|interromp)\w*\b/.test(t)) {
    return 'no';
  }
  if (/\b(sim|pode|autoriz|permit|libera|manda ver|manda|ok|tudo bem|claro|beleza|vai|segue|aprov)\w*\b/.test(t)) {
    return 'yes';
  }
  return null;
}

function activateAutoAllow(tool: string): void {
  const now = Date.now();
  if (!autoAllowMode) {
    autoAllowMode = { until: now + AUTO_ALLOW_WINDOW_MS, tools: new Set([tool]) };
  } else {
    autoAllowMode.tools.add(tool);
    autoAllowMode.until = now + AUTO_ALLOW_WINDOW_MS;
  }
  console.log(
    `[live] auto-allow ativo pra ${[...autoAllowMode.tools].join(',')} por ${AUTO_ALLOW_WINDOW_MS / 1000}s`,
  );
}

function clearAutoAllow(): void {
  if (autoAllowMode) {
    console.log('[live] auto-allow desativado (deny)');
    autoAllowMode = null;
  }
}

function armPermissionFallback(answer: 'yes' | 'no', source: 'user-voice' | 'model-voice'): void {
  if (!pendingClaudePermission) return;
  clearPermissionFallback();
  const captured = pendingClaudePermission.requestId;
  const capturedTool = pendingClaudePermission.tool;
  const allowed = answer === 'yes';
  // model-voice (Gemini falando "negado") = mais curto: já passou pela LLM,
  // se ela ainda não chamou a tool é porque não vai. user-voice = espera mais
  // pra dar chance da LLM processar.
  const delayMs = source === 'model-voice' ? 1500 : 2500;
  console.log(
    `[live] fallback armado (${answer} via ${source}) — resolverá em ${delayMs}ms se Gemini não chamar a tool`,
  );
  permissionFallbackTimer = setTimeout(() => {
    permissionFallbackTimer = null;
    if (
      pendingClaudePermission &&
      pendingClaudePermission.requestId === captured
    ) {
      console.warn(
        `[live] FALLBACK acionou (${answer} via ${source}) — Gemini não chamou claude_permission_decide`,
      );
      claude?.resolvePermission(captured, allowed);
      // Ativa/limpa auto-allow conforme a decisão
      if (allowed) activateAutoAllow(capturedTool);
      else clearAutoAllow();
      pendingClaudePermission = null;
      emit({
        type: 'claude_permission_resolved',
        requestId: captured,
        allowed,
      });
    } else {
      console.log('[live] fallback cancelado — pending mudou ou foi resolvida');
    }
  }, delayMs);
}

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

  // Service de uso do Claude (poll do ccusage a cada 30s).
  claudeUsage = new ClaudeUsageService((usage) => {
    emit({ type: 'claude_usage', usage });
  });
  setActiveClaudeUsageService(claudeUsage);
  void claudeUsage.start();

  mainWindow?.webContents.on('did-finish-load', () => {
    // Se já temos um snapshot, manda imediatamente pro renderer recém-pronto
    const last = claudeUsage?.getLast();
    if (last !== undefined) emit({ type: 'claude_usage', usage: last });

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
      type: 'claude_active_project',
      path: activeClaudeCwd,
      name: activeClaudeProjectName,
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
          const wasSpeaking = liveStateKind === 'speaking';
          liveStateKind = state.kind;
          emit({ type: 'live_state', state });
          // Quando Gemini termina de falar (speaking → ready), descarrega
          // qualquer anúncio do Claude que tava esperando.
          if (wasSpeaking && state.kind === 'ready') {
            flushPendingAnnouncement();
          }
          if (state.kind === 'ready') {
            // Flush das falas de webhook que chegaram durante boot/reconnect.
            // Pequeno delay pra dar prioridade pro briefing matinal se houver.
            setTimeout(() => flushPendingWebhookPhrases(), 500);
            // Pós-restart com --auto-test (argv ou env): dispacha validação
            // automática uma vez por boot.
            const autoTestRequested =
              process.argv.includes('--auto-test') ||
              process.env.PIXXEL_AUTO_TEST === '1';
            if (autoTestRequested && !autoTestDispatched) {
              autoTestDispatched = true;
              void runPendingAutoTest();
            }
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
            pendingClaudeAnnouncement = null;
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

          // Guards 2 e 3 — só rodam pra transcript do USUÁRIO (instrução
          // entrante). Detectam intenção e checam depois se Gemini disparou
          // a tool certa.
          if (role === 'user') {
            // Guard 2: pedido de mexer em código sem dispatch.
            // Gatilhos: verbo de ação + objeto técnico/arquivo.
            const norm = text
              .toLowerCase()
              .normalize('NFD')
              .replace(/[̀-ͯ]/g, '');
            const codeIntent =
              /\b(cria|criar|edita|editar|altera|alterar|muda|mudar|implementa|implementar|refator|corrige|corrigir|conserta|consertar|adiciona|adicionar|remove|remover|deleta|deletar|instala|instalar|roda|rodar|executa|executar|ajusta|ajustar|mexe|mexer)\b/.test(
                norm,
              ) &&
              /\b(arquivo|cod|codigo|projeto|funcao|botao|endpoint|estilo|cor|bug|teste|script|componente|api|rota|integra|integracao|libs?|pacote|comando|terminal|briefing|tool|widget|painel|sidebar|orb|app|tela|nodemodules|package|tsconfig|estilos|css|html|json|markdown|md)\w*\b/.test(
                norm,
              );
            if (codeIntent) {
              if (pendingDispatchCheck) clearTimeout(pendingDispatchCheck);
              const detectedAt = Date.now();
              pendingDispatchCheck = setTimeout(() => {
                pendingDispatchCheck = null;
                // Se claude_code_task foi chamada DEPOIS do detectedAt, ok.
                if (lastClaudeCodeTaskAtMs >= detectedAt) return;
                // Se save_idea/plan_feature ou outro fluxo pegou, também ok —
                // não temos como rastrear todos, mas o pior caso é mandar
                // lembrete uma vez. Custo baixo.
                console.warn(
                  '[guard] usuário pediu ação de código mas Gemini não disparou claude_code_task em 6s. Mandando lembrete.',
                );
                live?.sendText(
                  '[Sistema] Você acabou de receber um pedido pra mexer em ' +
                    'código/arquivo mas NÃO disparou claude_code_task (nem ' +
                    'save_idea/plan_feature). Dispare AGORA com base no último ' +
                    'pedido do usuário, ou se não couber em nenhuma tool, ' +
                    'pergunte se ele quer anotar/planejar/implementar.',
                );
              }, 6000);
            }

            // Guard 3: pergunta de estado sem chamar current_work_status.
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

          // Fallback duplo: pega tanto resposta do usuário ("sim/não") quanto
          // a verbalização do Gemini ("autorizado/negado"). Se Gemini não
          // chamar a tool no prazo, main resolve sozinho.
          if (!pendingClaudePermission) return;
          const answer = detectPermissionAnswer(text, role);
          if (!answer) return;
          console.log(
            `[live] transcript (${role}): "${text.slice(0, 80)}" → detecção=${answer}`,
          );
          armPermissionFallback(answer, role === 'user' ? 'user-voice' : 'model-voice');
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

          // Caminho memória → Caminho status do Claude (uso ccusage)
          if (call.name === 'claude_usage_status') {
            const usage = claudeUsage?.getLast() ?? null;
            if (!usage) {
              live?.sendToolResponse(call.id, call.name, {
                ok: false,
                reason: 'ccusage ainda não tem dados (poll roda a cada 30s) ou ' +
                  'falhou. Tente de novo em alguns segundos.',
              });
              return;
            }
            const fmtUsd = (n: number) => `$${n.toFixed(2)}`;
            const fmtPct = (q: { percent: number; usedUSD: number; limitUSD: number; resetsIn?: string }) =>
              `${q.percent}% (${fmtUsd(q.usedUSD)} de ${fmtUsd(q.limitUSD)})` +
              (q.resetsIn ? `, reseta em ${q.resetsIn}` : '');
            const lines: string[] = [];
            if (usage.session) lines.push(`Sessão de 5h: ${fmtPct(usage.session)}.`);
            else lines.push(`Sessão de 5h: ${fmtUsd(usage.costUSD)} usados (limite não calibrado).`);
            if (usage.weekly) lines.push(`Semana (total): ${fmtPct(usage.weekly)}.`);
            if (usage.weeklySonnet) lines.push(`Semana (Sonnet): ${fmtPct(usage.weeklySonnet)}.`);
            lines.push(
              `Bloco atual: ${usage.totalTokens.toLocaleString('pt-BR')} tokens ` +
                `(input ${usage.inputTokens.toLocaleString('pt-BR')}, output ${usage.outputTokens.toLocaleString('pt-BR')}, ` +
                `cache create ${usage.cacheCreationTokens.toLocaleString('pt-BR')}, cache read ${usage.cacheReadTokens.toLocaleString('pt-BR')}).`,
            );
            if (usage.burnRate) {
              lines.push(
                `Burn rate: ${Math.round(usage.burnRate.tokensPerMinute).toLocaleString('pt-BR')} tokens/min, ` +
                  `${fmtUsd(usage.burnRate.costPerHour)}/hora.`,
              );
            }
            if (usage.projection) {
              lines.push(
                `Projeção do bloco: ${usage.projection.totalTokens.toLocaleString('pt-BR')} tokens, ` +
                  `${fmtUsd(usage.projection.totalCost)}, faltam ${usage.projection.remainingMinutes} min.`,
              );
            }
            if (usage.models.length > 0) lines.push(`Modelos usados: ${usage.models.join(', ')}.`);
            if (usage.windowStart && usage.windowEnd) {
              lines.push(`Janela do bloco: ${usage.windowStart} → ${usage.windowEnd}.`);
            }
            live?.sendToolResponse(call.id, call.name, {
              ok: true,
              text: lines.join(' '),
              meta: {
                session: usage.session,
                weekly: usage.weekly,
                weeklySonnet: usage.weeklySonnet,
                costUSD: usage.costUSD,
                totalTokens: usage.totalTokens,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheCreationTokens: usage.cacheCreationTokens,
                cacheReadTokens: usage.cacheReadTokens,
                models: usage.models,
                burnRate: usage.burnRate,
                projection: usage.projection,
                windowStart: usage.windowStart,
                windowEnd: usage.windowEnd,
              },
            });
            return;
          }

          // Caminho 0: claude_code_task — assíncrono, dispara o ClaudeRunner
          // e responde ao Gemini com confirmação curta. O texto final do
          // Claude é mandado de volta via live.sendText quando ele termina
          // (ver onResult do runner).
          if (call.name === 'claude_code_task') {
            const task = String(call.args.task ?? '').trim();
            if (!task) {
              live?.sendToolResponse(call.id, call.name, {
                ok: false,
                reason: 'task vazia',
              });
              return;
            }
            // Guard 1: dedupe permission-grant double-dispatch. Se permission
            // foi concedida há <5s e claude já tá rodando, esse claude_code_task
            // é o BUG conhecido do Gemini (re-disparar a tarefa que já tava
            // rodando). Descarta com aviso pro modelo aprender.
            const sincePermissionMs = Date.now() - lastPermissionGrantAtMs;
            if (
              sincePermissionMs < PERMISSION_GRANT_DEDUPE_MS &&
              claude?.isRunning()
            ) {
              console.warn(
                `[guard] descartado claude_code_task duplicado (${sincePermissionMs}ms após permission grant). task="${task.slice(0, 60)}"`,
              );
              live?.sendToolResponse(call.id, call.name, {
                ok: false,
                reason: 'duplicate_after_permission',
                _note:
                  'BUG detectado: você acabou de conceder uma permissão e ' +
                  'redisparou claude_code_task no mesmo turno. A tarefa JÁ ' +
                  'estava rodando — não precisa redisparar. Apenas continue ' +
                  'aguardando "[Sistema] Terminei...". NÃO mencione esse erro ' +
                  'ao usuário, só siga o fluxo normal sem comentar.',
              });
              return;
            }
            lastClaudeCodeTaskAtMs = Date.now();
            // Cancela qualquer reminder pendente — Gemini disparou a tool.
            if (pendingDispatchCheck) {
              clearTimeout(pendingDispatchCheck);
              pendingDispatchCheck = null;
            }
            // Resolve project ANTES de decidir entre start/queue — fixa o cwd
            // no momento do pedido (evita ambiguidade se mudar depois).
            const projectQuery = String(call.args.project ?? '').trim();
            let cwd = activeClaudeCwd;
            let projectName = activeClaudeProjectName;
            if (projectQuery) {
              const found = findProject(projectQuery);
              if (!found.ok) {
                const alts = found.alternatives ?? [];
                const altText = alts.length
                  ? ` Disponíveis: ${alts.map((a) => a.name).join(', ')}.`
                  : '';
                live?.sendToolResponse(call.id, call.name, {
                  ok: false,
                  reason: found.reason + altText,
                });
                return;
              }
              cwd = found.project.path;
              projectName = found.project.name;
              setActiveProject(found.project.path, found.project.name);
            }
            const r = await enqueueOrStartClaudeTask({
              task,
              cwd,
              projectName,
              source: 'voice',
            });
            if ('error' in r) {
              live?.sendToolResponse(call.id, call.name, {
                ok: false,
                reason: r.error,
              });
              return;
            }
            if ('conflict' in r) {
              const kindLabel = r.current.kind === 'code' ? 'tarefa de código' : 'sessão';
              live?.sendToolResponse(call.id, call.name, {
                ok: false,
                reason: 'session_open',
                text:
                  `[Conflito] Já tem uma ${kindLabel} aberta: ` +
                  `"${r.current.description}" (${r.current.age}). Pergunte ao ` +
                  `usuário em primeira pessoa se quer PAUSAR (salva o estado) ` +
                  `ou INTERROMPER (descarta) a atual antes de começar a nova ` +
                  `"${task}". Quando ele responder, chame pause_current_work ` +
                  `ou interrupt_current_work, e DEPOIS chame claude_code_task ` +
                  `de novo. NUNCA mencione "Claude" — é tudo VOCÊ.`,
              });
              return;
            }
            if ('queued' in r) {
              live?.sendToolResponse(call.id, call.name, {
                ok: true,
                status: 'queued_async',
                position: r.position,
                _note:
                  'Tarefa enfileirada (começa quando a atual terminar). ' +
                  'Confirme em primeira pessoa. NÃO diga "terminei/feito" — ' +
                  'o resultado chega depois numa mensagem separada do sistema.',
              });
              return;
            }
            live?.sendToolResponse(call.id, call.name, {
              ok: true,
              status: 'running_async',
              _note:
                'Tarefa COMEÇOU e está rodando em background. Confirme em ' +
                'primeira pessoa que tá fazendo ("já tô nisso", "vou nessa"). ' +
                'NUNCA diga "terminei", "feito", "pronto" agora — o resultado ' +
                'chega DEPOIS numa mensagem "[Sistema] Terminei...". Até essa ' +
                'mensagem chegar, a tarefa AINDA está em execução.',
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

          // Caminho 0.3: claude_permission_decide / claude_cancel_task —
          // Gemini repassa decisão do usuário pra pedidos do Claude (sim/não
          // numa permissão, ou cancelamento da run).
          if (CLAUDE_CONTROL_TOOL_NAMES.has(call.name)) {
            if (call.name === 'claude_cancel_task') {
              const wasRunning = claude?.isRunning() ?? false;
              const queueLen = claudeQueue.length;
              if (queueLen > 0) {
                console.log(`[claude] cancel via voz: descartando ${queueLen} da fila`);
                claudeQueue.length = 0;
                emitClaudeQueue();
              }
              if (wasRunning) {
                claudeCancelInProgress = true;
                await claude?.cancel();
              }
              // Limpa pendências de permissão também, senão o Claude pode ficar
              // travado em ask_user enquanto recebe SIGTERM.
              if (pendingClaudePermission) {
                clearPermissionFallback();
                claude?.resolvePermission(
                  pendingClaudePermission.requestId,
                  false,
                );
                emit({
                  type: 'claude_permission_resolved',
                  requestId: pendingClaudePermission.requestId,
                  allowed: false,
                });
                pendingClaudePermission = null;
              }
              // Sem `text` — Gemini fala em primeira pessoa no mesmo turno.
              // Devolve só dados estruturados pra ele saber o que aconteceu.
              live?.sendToolResponse(call.id, call.name, {
                ok: true,
                wasRunning,
                queueDiscarded: queueLen,
              });
              return;
            }
            if (call.name === 'claude_permission_decide') {
              const allowed = Boolean(call.args.allowed);
              if (!pendingClaudePermission) {
                live?.sendToolResponse(call.id, call.name, {
                  ok: false,
                  reason: 'não tem nenhum pedido de permissão pendente',
                });
                return;
              }
              const reqId = pendingClaudePermission.requestId;
              const tool = pendingClaudePermission.tool;
              clearPermissionFallback();
              claude?.resolvePermission(reqId, allowed);
              if (allowed) activateAutoAllow(tool);
              else clearAutoAllow();
              pendingClaudePermission = null;
              // Marca pra dedupe: Gemini às vezes dispara claude_code_task junto
              // com o permission grant (BUG do modelo). Janela de 5s vai
              // descartar qualquer claude_code_task que chegar logo em seguida
              // se Claude já estiver running.
              lastPermissionGrantAtMs = Date.now();
              emit({ type: 'claude_permission_resolved', requestId: reqId, allowed });
              // Sem `text` no retorno — evita o Gemini verbalizar uma segunda
              // vez (a primeira é a confirmação curta no mesmo turno do call).
              live?.sendToolResponse(call.id, call.name, { ok: true, allowed });
              return;
            }
          }

          // Caminho 0.4: ideas tools (save_idea, plan_feature) — anexa em
          // IDEIAS.md. plan_feature ainda dispara claude_code_task pra revisar
          // tecnicamente o plano (assíncrono, mesmo padrão do claude_code_task).
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
              if (!saved.ok) {
                live?.sendToolResponse(call.id, call.name, {
                  ok: false,
                  reason: saved.reason,
                });
                return;
              }
              // Dispara Claude pra revisar tecnicamente, no cwd do monorepo
              // (onde IDEIAS.md vive). Roda no DEFAULT_CLAUDE_PROJECT_DIR
              // independente do projeto ativo — IDEIAS.md tá lá.
              const reviewPrompt =
                `Revise tecnicamente o plano da feature "${title}" que acabei ` +
                `de adicionar em ${IDEAS_FILE_PATH}. Procure pelo bloco com ` +
                `o anchor "${saved.anchor}". Avalie viabilidade técnica, ` +
                `dependências faltando, riscos, e alternativas mais simples ` +
                `se houver. Adicione uma subseção "#### Revisão técnica (Claude)" ` +
                `logo após o "#### Plano (Gemini)". Seja objetivo: 4-8 bullets.`;
              const r = await enqueueOrStartClaudeTask({
                task: reviewPrompt,
                cwd: DEFAULT_CLAUDE_PROJECT_DIR,
                projectName: 'pixxel (revisão de plano)',
                source: 'plan-review',
              });
              if ('error' in r) {
                // Plano já tá salvo; só não vai ter revisão automática.
                live?.sendToolResponse(call.id, call.name, {
                  ok: true,
                  text: `Plano de "${title}" salvo, mas não consegui agendar revisão: ${r.error}`,
                });
                return;
              }
              if ('conflict' in r) {
                // Plano salvo mas não consigo iniciar a revisão técnica agora —
                // tem outra sessão aberta. Não bloqueia o save_idea, só avisa.
                live?.sendToolResponse(call.id, call.name, {
                  ok: true,
                  text:
                    `Plano de "${title}" salvo. Tem outra sessão aberta ` +
                    `(${r.current.description}), então a revisão técnica fica ` +
                    `pra quando ela terminar.`,
                });
                return;
              }
              if ('queued' in r) {
                live?.sendToolResponse(call.id, call.name, {
                  ok: true,
                  planSaved: title,
                  reviewQueued: true,
                  position: r.position,
                });
                return;
              }
              live?.sendToolResponse(call.id, call.name, {
                ok: true,
                planSaved: title,
                reviewStarted: true,
              });
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

          // Caminho 0.6: restart_app — reinicia Electron preservando intenção
          // de Live. Manda o response, dá um respiro pro Gemini falar a frase
          // de aviso, e relança com flag `--auto-live` pro novo processo
          // religar a sessão automaticamente. Se test_plan vier, persiste e
          // adiciona --auto-test pra validação rodar pós-restart.
          if (call.name === 'restart_app') {
            const testPlan =
              typeof call.args.test_plan === 'string' && call.args.test_plan.trim()
                ? call.args.test_plan.trim()
                : null;
            live?.sendToolResponse(call.id, call.name, {
              ok: true,
              text: testPlan
                ? 'Reiniciando agora — já volto, reconecto e rodo a validação.'
                : 'Reiniciando agora — já volto e reconecto sozinho.',
            });
            const finishRestart = () => {
              const wantTest = !!testPlan;
              if (app.isPackaged) {
                // Build packageado: app.relaunch funciona normal — o execPath
                // é o binário final do app, sem electron-vite no caminho.
                const baseArgs = process.argv
                  .slice(1)
                  .filter((a) => a !== '--auto-live' && a !== '--auto-test');
                const extra = ['--auto-live'];
                if (wantTest) extra.push('--auto-test');
                app.relaunch({ args: [...baseArgs, ...extra] });
                app.exit(0);
                return;
              }
              // Dev: rodando via `electron-vite dev`. app.relaunch lança o
              // electron solto, fora do dev server, e mata o terminal pai.
              // Em vez disso, sobe um `npm run dev:desktop` detached com
              // sleep de 2s pra dar tempo do processo atual morrer e o
              // electron-vite anterior liberar a porta do vite. Sinaliza
              // intenção de auto-live/auto-test via env (já que --argv não
              // sobrevive ao npm script).
              const repoRoot = pathResolve(app.getAppPath(), '..', '..');
              const env = { ...process.env };
              env.PIXXEL_AUTO_LIVE = '1';
              env.PIXXEL_AUTO_TEST = wantTest ? '1' : '';
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
            if (testPlan) {
              void savePendingTest({
                testPlan,
                projectPath: activeClaudeCwd,
                projectName: activeClaudeProjectName,
              })
                .catch((err) => console.warn('[restart_app] savePendingTest falhou:', err))
                .finally(() => setTimeout(finishRestart, 1500));
            } else {
              setTimeout(finishRestart, 1500);
            }
            return;
          }

          // Antes da integração: enrich `current_work_status` com info da
          // fila de tarefas (active-work já tem a entry running, mas não
          // sabe da fila). Quando há queue, append pro Gemini saber.
          // Marca chamada de current_work_status — cancela reminder pendente
          // do guard 3 (Gemini consultou estado, não vai alucinar).
          if (call.name === 'current_work_status') {
            lastCurrentWorkStatusAtMs = Date.now();
            if (pendingStateCheck) {
              clearTimeout(pendingStateCheck);
              pendingStateCheck = null;
            }
          }

          if (call.name === 'current_work_status' && claudeQueue.length > 0) {
            const intRes = await executeIntegration(call.name, call.args);
            const baseText = intRes?.ok ? intRes.text : '';
            const queueText = `Tem ${claudeQueue.length} tarefa(s) na fila esperando começar.`;
            const combined = [baseText, queueText].filter(Boolean).join(' ');
            live?.sendToolResponse(call.id, call.name, {
              ok: true,
              text: combined,
              _note:
                'Confirme em PRIMEIRA PESSOA. NUNCA mencione "Claude" nem ' +
                'agente externo.',
            });
            return;
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
              // open_project bem sucedido → marca como projeto ativo do Claude.
              // Não precisa reset: o runner mantém um session_id por cwd e
              // resume automaticamente na próxima start() neste projeto.
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

  // ===== Claude Code =====
  claude = new ClaudeRunner({
    onState: (state) => emit({ type: 'claude_state', state }),
    onSessionId: (sid) => {
      // Persiste o session_id na entry active-work atual pra resume depois.
      void getActiveWorkStore().setClaudeSessionId(sid);
    },
    onAssistantText: (delta) => {
      emit({ type: 'claude_text', delta });
      workLog.appendAssistantText(delta);
    },
    onToolUse: (tool, input) => {
      emit({ type: 'claude_tool_use', tool, input });
      void workLog.appendToolUse(tool, input);
      // Atualiza lastStep da sessão active-work pra usuário lembrar onde
      // tava se interrompido. Resumo curto por tipo de tool.
      const obj = (input ?? {}) as Record<string, unknown>;
      let summary = tool;
      if (tool === 'Edit' || tool === 'Write' || tool === 'Read') {
        const file = String(obj.file_path ?? obj.path ?? '');
        if (file) summary = `${tool} ${file.split('/').pop() ?? file}`;
      } else if (tool === 'Bash') {
        const cmd = String(obj.command ?? '').slice(0, 60);
        if (cmd) summary = `Bash: ${cmd}`;
      }
      void getActiveWorkStore().updateLastStep(summary);
    },
    onPermissionRequest: (request) => {
      // Auto-allow: usuário autorizou esse tool recentemente — libera direto
      // sem perguntar de novo. Comum quando Claude faz vários Edits em sequência.
      const now = Date.now();
      if (
        autoAllowMode &&
        autoAllowMode.until > now &&
        autoAllowMode.tools.has(request.tool)
      ) {
        console.log(
          `[live] auto-allow ${request.tool} (${request.requestId.slice(0, 8)}) — janela ativa`,
        );
        // Estende a janela a cada permissão auto-autorizada (mantém o ritmo).
        autoAllowMode.until = now + AUTO_ALLOW_WINDOW_MS;
        claude?.resolvePermission(request.requestId, true);
        // Ainda emite request → resolved pra UI atualizar (mostra brevemente
        // que tool rolou, mas card some logo).
        emit({ type: 'claude_permission_request', request });
        emit({
          type: 'claude_permission_resolved',
          requestId: request.requestId,
          allowed: true,
        });
        return;
      }

      pendingClaudePermission = request;
      clearPermissionFallback();
      emit({ type: 'claude_permission_request', request });

      // Debounce do anúncio: se Gemini perguntou nos últimos 8s, não pergunta
      // de novo — fallback de voz vai resolver a próxima também.
      if (live) {
        const sinceLast = now - lastPermissionAnnounceMs;
        if (sinceLast < PERMISSION_ANNOUNCE_DEBOUNCE_MS) {
          console.log(
            `[live] permissão repetida pra ${request.tool} (${sinceLast}ms desde última) — sem anúncio (debounce)`,
          );
          return;
        }
        lastPermissionAnnounceMs = now;
        // Fala em primeira pessoa — pro usuário, é o assistente fazendo,
        // não delegando. Detalhe técnico (nome da tool) some; só o que vai
        // acontecer aparece no anúncio.
        const note =
          `[Sistema] Pra continuar, preciso ${request.summary.toLowerCase()}. ` +
          `Pergunte ao usuário curto se pode (em primeira pessoa, tipo "posso ` +
          `${request.summary.toLowerCase()}?"). Quando ele responder, chame ` +
          `claude_permission_decide com allowed=true (sim) ou allowed=false (não). ` +
          `NUNCA mencione "Claude" nem que outro agente está fazendo.`;
        announceWhenLiveIdle(note);
      }
    },
    onResult: (result) => {
      emit({ type: 'claude_result', ok: result.ok, text: result.text });
      // Cada sessão Claude tem seu próprio espaço de auto-allow/debounce —
      // não carrega pra próxima task.
      autoAllowMode = null;
      lastPermissionAnnounceMs = 0;
      // Fecha a sessão do work-log com o resultado final.
      void workLog.endSession({ ok: result.ok, finalText: result.text });
      // Fecha a entry de active-work conforme o resultado. Considera entries
      // running E paused (paused acontece quando Gemini chama pause_current_work
      // no meio da execução do Claude); se ficar olhando só running, paused
      // viram zumbis com endedAt undefined pra sempre.
      const aw = getActiveWorkStore();
      const open = aw.openEntry();
      if (open && open.kind === 'code') {
        if (claudeCancelInProgress) {
          void aw.interruptCurrent('cancelado pelo usuário');
        } else if (result.ok) {
          void aw.endWork(result.text.slice(0, 280));
        } else {
          void aw.markFailed(result.text.slice(0, 280));
        }
      }
      claudeCancelInProgress = false;
      // Se Live tá ativo, joga o resultado como mensagem de usuário pra ele
      // verbalizar. Mas se Gemini ainda tá falando (ex: ainda dizendo
      // "ok, comecei a trabalhar"), enfileira pra não cortar a fala dele —
      // o flush acontece quando ele volta pra 'ready'.
      if (live && result.text) {
        // Resultado entra como se VOCÊ (Gemini) tivesse acabado de fazer —
        // primeira pessoa, sem mencionar Claude nem agente externo.
        const note = result.ok
          ? `[Sistema] Terminei o que estava fazendo. Resultado: ${result.text}. ` +
            `Comente em primeira pessoa, como se você mesmo tivesse feito. ` +
            `NUNCA mencione "Claude" nem outro agente.`
          : `[Sistema] Não consegui terminar. Motivo: ${result.text}. ` +
            `Avise o usuário em primeira pessoa, sem mencionar "Claude" nem ` +
            `outro agente.`;
        announceWhenLiveIdle(note);
      }
      // Próxima tarefa da fila Claude, se tiver.
      tryDequeueClaudeTask();
    },
  });

  ipcMain.handle('assistant:claude-start', async (_event, prompt: string) => {
    if (!claude) return { ok: false, reason: 'runner_not_ready' };
    const text = (prompt ?? '').trim();
    if (!text) return { ok: false, reason: 'prompt_vazio' };
    const result = await enqueueOrStartClaudeTask({
      task: text,
      cwd: activeClaudeCwd,
      projectName: activeClaudeProjectName,
      source: 'chat',
    });
    if ('error' in result) return { ok: false, reason: result.error };
    if ('conflict' in result) {
      // No fluxo de chat (UI), devolve conflict pro renderer mostrar diálogo.
      return {
        ok: false,
        reason: 'session_open',
        conflict: {
          description: result.current.description,
          kind: result.current.kind,
          age: result.current.age,
        },
      };
    }
    if ('queued' in result) {
      return { ok: true, queued: true, position: result.position };
    }
    return { ok: true };
  });

  ipcMain.handle('assistant:claude-cancel', async () => {
    // Cancel manual = parar tudo. Limpa fila pra não disparar próxima
    // automática quando a atual morrer.
    if (claudeQueue.length > 0) {
      console.log(`[claude] cancel: descartando ${claudeQueue.length} da fila`);
      claudeQueue.length = 0;
      emitClaudeQueue();
    }
    if (claude?.isRunning()) {
      claudeCancelInProgress = true;
    }
    await claude?.cancel();
  });

  ipcMain.on(
    'assistant:claude-permission-response',
    (_event, requestId: string, allowed: boolean) => {
      claude?.resolvePermission(requestId, allowed);
      if (pendingClaudePermission?.requestId === requestId) {
        const tool = pendingClaudePermission.tool;
        if (allowed) activateAutoAllow(tool);
        else clearAutoAllow();
        pendingClaudePermission = null;
        clearPermissionFallback();
      }
    },
  );

  ipcMain.handle('assistant:claude-reset-session', () => {
    // "Nova conversa" sempre opera no projeto que o próximo start vai usar,
    // não no último que rodou — assim o usuário pode trocar de projeto e
    // depois zerar a conversa do novo sem afetar o anterior.
    claude?.resetSession(activeClaudeCwd);
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
  void claude?.cancel();
  claudeUsage?.stop();
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
