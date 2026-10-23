// Poller de notificações do ClickUp (REST direto, política da empresa proíbe webhooks).
//
// O endpoint /team/{id}/notifications NÃO existe na API pública v2 (404).
// Estratégia: detectar via diff de:
//
//   1. Tasks atribuídas a mim (v2: GET /team/{teamId}/task)
//      - Filtra por date_updated_gt={lastPolledAt} (só as que mudaram)
//      - Compara com knownTaskIds → tasks novas = task_assigned
//
//   2. Comments em cada task atribuída atualizada (v2: GET /task/{id}/comment)
//      - Compara comment ids com snapshot anterior por task
//      - Filtra comments meus (skip se user.id == myUserId)
//      - Novos comments = task_comment
//
//   3. Mensagens em DMs (v3: GET /workspaces/{id}/chat/channels + messages)
//      - Lista canais directMessage
//      - Pra cada canal, fetch messages com limit
//      - Compara id com lastChatMessageIdsByChannel
//      - Filtra mensagens minhas (skip se sender == me)
//      - Novas mensagens = chat_message
//
// Persiste estado em ~/pixxel/state/clickup-notifications.json.
// Bootstrap: primeiro run só captura snapshot sem disparar (lastPolledAt=0).

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import {
  clickupFetch,
  getTeamId,
  getUserId,
  isClickupAvailable,
} from './clickup.js';
import type { NotificationsWidget } from '@assistant/shared/widgets';
import { dataPath } from '../data-dir.js';

const STATE_FILE = dataPath('state', 'clickup-notifications.json');
const POLL_INTERVAL_MS = 5 * 60_000;
// Limita comments armazenados por task pra não inchar o state file.
const COMMENTS_PER_TASK_CAP = 50;
// Limita ids de mensagens armazenados por canal de chat.
const MSGS_PER_CHANNEL_CAP = 50;
const V3_BASE = 'https://api.clickup.com/api/v3';

type State = {
  lastPolledAt: number;
  // Set de task ids que já vimos atribuídas a mim. Usado pra detectar
  // "novamente atribuída" vs "atualizada".
  knownTaskIds: string[];
  // Por task: ids de comments já vistos. Usado pra detectar comments novos.
  commentIdsByTask: Record<string, string[]>;
  // Por canal de chat: ids de mensagens já vistas.
  msgIdsByChannel: Record<string, string[]>;
};

async function readState(): Promise<State> {
  try {
    const txt = await fs.readFile(STATE_FILE, 'utf-8');
    const s = JSON.parse(txt) as Partial<State>;
    return {
      lastPolledAt: typeof s.lastPolledAt === 'number' ? s.lastPolledAt : 0,
      knownTaskIds: Array.isArray(s.knownTaskIds) ? s.knownTaskIds : [],
      commentIdsByTask:
        s.commentIdsByTask && typeof s.commentIdsByTask === 'object'
          ? (s.commentIdsByTask as Record<string, string[]>)
          : {},
      msgIdsByChannel:
        s.msgIdsByChannel && typeof s.msgIdsByChannel === 'object'
          ? (s.msgIdsByChannel as Record<string, string[]>)
          : {},
    };
  } catch {
    return {
      lastPolledAt: 0,
      knownTaskIds: [],
      commentIdsByTask: {},
      msgIdsByChannel: {},
    };
  }
}

async function writeState(s: State): Promise<void> {
  try {
    await fs.mkdir(dataPath('state'), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(s), 'utf-8');
  } catch (err) {
    console.warn('[clickup-notif] persist falhou:', err);
  }
}

// ===== Helpers HTTP =====

const TOKEN = () => process.env.CLICKUP_TOKEN ?? '';

async function v3Fetch<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T | null> {
  const token = TOKEN();
  if (!token) return null;
  const url = new URL(`${V3_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  try {
    const res = await fetch(url, {
      headers: { Authorization: token, accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text();
      console.warn(
        `[clickup-notif] v3 api error ${res.status} on ${path}:`,
        body.slice(0, 300),
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn('[clickup-notif] v3 fetch failed:', err);
    return null;
  }
}

// ===== Tipos da API =====

type V2Task = {
  id: string;
  custom_id?: string | null;
  name: string;
  url?: string;
  date_updated?: string;
  status?: { status?: string };
  assignees?: Array<{ id: number; username?: string }>;
};

type V2Comment = {
  id: string;
  comment_text?: string;
  user: { id: number; username?: string };
  date?: string;
};

type V3Channel = {
  id: string;
  type?: string;
  name?: string;
  members?: Array<{ id?: string; username?: string }>;
  // ClickUp v3 usa nomes diferentes em alguns endpoints — toleramos
  workspace_id?: string;
};

type V3Message = {
  id: string;
  type?: string;
  textContent?: string;
  text_content?: string;
  user?: { id?: number | string; username?: string };
  // dependendo do endpoint vem como `userId` no top
  userId?: number | string;
  date?: number | string;
  created_at?: number | string;
};

// ===== Detecção e build de items =====

/** Usa custom_id (ex: PIXXEL-123) se a task tiver um, senão o id interno. */
function displayTaskId(task: V2Task): string {
  return task.custom_id || task.id;
}

function buildAssignedItem(task: V2Task): NotificationsWidget['items'][number] {
  return {
    id: `task-assigned:${task.id}`,
    kind: 'task_assigned',
    title: `Nova task atribuída: ${task.name}`,
    detail: task.status?.status ? `status: ${task.status.status}` : undefined,
    taskId: displayTaskId(task),
    taskUrl: task.url,
    date: new Date().toISOString(),
  };
}

function buildCommentItem(
  task: V2Task,
  comment: V2Comment,
): NotificationsWidget['items'][number] {
  const dateMs = comment.date
    ? typeof comment.date === 'number'
      ? comment.date
      : parseInt(comment.date, 10) || Date.now()
    : Date.now();
  return {
    id: `task-comment:${comment.id}`,
    kind: 'task_comment',
    title: `Comentário em ${task.name}`,
    detail: comment.comment_text,
    actor: comment.user?.username,
    taskId: displayTaskId(task),
    taskUrl: task.url,
    date: new Date(dateMs).toISOString(),
  };
}

function buildChatItem(
  channel: V3Channel,
  msg: V3Message,
): NotificationsWidget['items'][number] {
  const dateRaw = msg.created_at ?? msg.date ?? Date.now();
  const dateMs =
    typeof dateRaw === 'number' ? dateRaw : parseInt(String(dateRaw), 10) || Date.now();
  const text = msg.textContent ?? msg.text_content ?? '';
  const sender =
    msg.user?.username ??
    channel.members?.find((m) => String(m.id) === String(msg.userId ?? msg.user?.id))
      ?.username;
  return {
    id: `chat-msg:${msg.id}`,
    kind: 'chat_message',
    title: sender ? `Mensagem de ${sender}` : 'Nova mensagem privada',
    detail: text || undefined,
    actor: sender,
    date: new Date(dateMs).toISOString(),
  };
}

// ===== Resumo agregado =====

export function summarizeForVoice(items: NotificationsWidget['items']): string {
  if (items.length === 0) return '';
  const counts = { task_assigned: 0, task_comment: 0, mention: 0, chat_message: 0, other: 0 };
  for (const i of items) counts[i.kind] += 1;

  const parts: string[] = [];
  if (counts.task_assigned > 0) {
    parts.push(
      counts.task_assigned === 1
        ? 'uma task nova atribuída'
        : `${counts.task_assigned} tasks novas atribuídas`,
    );
  }
  if (counts.task_comment > 0) {
    parts.push(
      counts.task_comment === 1 ? 'um comentário novo' : `${counts.task_comment} comentários novos`,
    );
  }
  if (counts.chat_message > 0) {
    parts.push(
      counts.chat_message === 1
        ? 'uma mensagem privada'
        : `${counts.chat_message} mensagens privadas`,
    );
  }
  if (parts.length === 0) {
    parts.push(items.length === 1 ? 'uma notificação' : `${items.length} notificações`);
  }

  let summary: string;
  if (parts.length === 1) summary = parts[0];
  else if (parts.length === 2) summary = `${parts[0]} e ${parts[1]}`;
  else summary = `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`;

  const actors = new Set(items.map((i) => i.actor).filter(Boolean));
  if (actors.size === 1 && items.length === 1) {
    return `Você tem ${summary} de ${[...actors][0]}.`;
  }
  return `Você tem ${summary} no ClickUp.`;
}

// ===== Pollers individuais =====

async function pollTasksAndComments(
  teamId: string,
  myUserId: number,
  state: State,
  bootstrap: boolean,
): Promise<{
  items: NotificationsWidget['items'];
  newKnownTaskIds: string[];
  newCommentIds: Record<string, string[]>;
}> {
  const items: NotificationsWidget['items'] = [];
  const knownSet = new Set(state.knownTaskIds);

  // Lista tasks atribuídas a mim, atualizadas desde o último poll.
  const params: Record<string, string> = {
    'assignees[]': String(myUserId),
    include_closed: 'false',
    subtasks: 'true',
    page: '0',
  };
  if (state.lastPolledAt > 0) {
    params.date_updated_gt = String(state.lastPolledAt);
  }
  const data = await clickupFetch<{ tasks: V2Task[] }>(`/team/${teamId}/task`, params);
  const tasks = data?.tasks ?? [];

  const newCommentIds: Record<string, string[]> = { ...state.commentIdsByTask };
  const newKnownTaskIdsSet = new Set(state.knownTaskIds);

  for (const task of tasks) {
    newKnownTaskIdsSet.add(task.id);
    // Detecta nova atribuição
    if (!bootstrap && !knownSet.has(task.id)) {
      items.push(buildAssignedItem(task));
    }
    // Busca comments dessa task
    const cdata = await clickupFetch<{ comments: V2Comment[] }>(`/task/${task.id}/comment`);
    const comments = cdata?.comments ?? [];
    const knownCommentSet = new Set(state.commentIdsByTask[task.id] ?? []);
    const fresh = comments.filter(
      (c) => !knownCommentSet.has(c.id) && Number(c.user?.id) !== myUserId,
    );
    if (!bootstrap) {
      for (const c of fresh) items.push(buildCommentItem(task, c));
    }
    // Atualiza snapshot de comments dessa task
    const allCommentIds = comments.map((c) => c.id);
    newCommentIds[task.id] = [
      ...new Set([...allCommentIds, ...(state.commentIdsByTask[task.id] ?? [])]),
    ].slice(0, COMMENTS_PER_TASK_CAP);
  }

  return {
    items,
    newKnownTaskIds: [...newKnownTaskIdsSet],
    newCommentIds,
  };
}

async function pollChatDMs(
  workspaceId: string,
  myUserId: number,
  state: State,
  bootstrap: boolean,
): Promise<{
  items: NotificationsWidget['items'];
  newMsgIdsByChannel: Record<string, string[]>;
}> {
  const items: NotificationsWidget['items'] = [];
  const newMsgIdsByChannel: Record<string, string[]> = { ...state.msgIdsByChannel };

  // Lista canais de DM. v3 retorna { data: [...] } na maioria dos endpoints.
  const channelsRes = await v3Fetch<{ data?: V3Channel[] }>(
    `/workspaces/${workspaceId}/chat/channels`,
  );
  if (!channelsRes) return { items: [], newMsgIdsByChannel };
  const all = channelsRes.data ?? [];
  // Filtra DMs (1:1). Inclui group dms? Por ora só directMessage.
  const dms = all.filter((c) => {
    const t = (c.type ?? '').toLowerCase();
    return t === 'directmessage' || t === 'dm' || t === 'direct_message';
  });

  for (const ch of dms) {
    const msgsRes = await v3Fetch<{ data?: V3Message[] }>(
      `/workspaces/${workspaceId}/chat/channels/${ch.id}/messages`,
      { limit: '20' },
    );
    if (!msgsRes) continue;
    const msgs = msgsRes.data ?? [];
    const knownIds = new Set(state.msgIdsByChannel[ch.id] ?? []);
    const fresh = msgs.filter((m) => {
      if (knownIds.has(m.id)) return false;
      const senderId = m.user?.id ?? m.userId;
      if (senderId != null && Number(senderId) === myUserId) return false;
      return true;
    });
    if (!bootstrap) {
      for (const m of fresh) items.push(buildChatItem(ch, m));
    }
    const allIds = msgs.map((m) => m.id);
    newMsgIdsByChannel[ch.id] = [
      ...new Set([...allIds, ...(state.msgIdsByChannel[ch.id] ?? [])]),
    ].slice(0, MSGS_PER_CHANNEL_CAP);
  }

  return { items, newMsgIdsByChannel };
}

// ===== Função principal =====

export type NotificationsBatch = {
  items: NotificationsWidget['items'];
  summary: string;
};

export async function pollClickupNotificationsOnce(): Promise<NotificationsBatch | null> {
  if (!isClickupAvailable()) return null;
  try {
    const teamId = await getTeamId();
    const userId = await getUserId();
    if (!teamId || userId == null) return null;
    const state = await readState();
    const bootstrap = state.lastPolledAt === 0;

    const tasksRes = await pollTasksAndComments(teamId, userId, state, bootstrap);
    const chatRes = await pollChatDMs(teamId, userId, state, bootstrap);

    const items = [...tasksRes.items, ...chatRes.items];
    const now = Date.now();
    await writeState({
      lastPolledAt: now,
      knownTaskIds: tasksRes.newKnownTaskIds,
      commentIdsByTask: tasksRes.newCommentIds,
      msgIdsByChannel: chatRes.newMsgIdsByChannel,
    });

    if (bootstrap) {
      console.log(
        `[clickup-notif] bootstrap: snapshot inicial (${tasksRes.newKnownTaskIds.length} tasks, ${Object.keys(chatRes.newMsgIdsByChannel).length} canais), nada disparado`,
      );
      return null;
    }
    if (items.length === 0) return null;
    return { items, summary: summarizeForVoice(items) };
  } catch (err) {
    console.warn('[clickup-notif] poll falhou:', err);
    return null;
  }
}

type PollerOptions = {
  onBatch: (batch: NotificationsBatch) => void;
};

export function startClickupNotificationsPoller(opts: PollerOptions): () => void {
  if (!isClickupAvailable()) {
    console.log('[clickup-notif] sem CLICKUP_TOKEN — poller não iniciado');
    return () => {};
  }
  let cancelled = false;
  let running = false;

  async function pollOnce(): Promise<void> {
    if (cancelled || running) return;
    running = true;
    try {
      const batch = await pollClickupNotificationsOnce();
      if (batch) opts.onBatch(batch);
    } finally {
      running = false;
    }
  }

  const startTimer = setTimeout(() => void pollOnce(), 30_000);
  const interval = setInterval(() => void pollOnce(), POLL_INTERVAL_MS);

  return () => {
    cancelled = true;
    clearTimeout(startTimer);
    clearInterval(interval);
  };
}
