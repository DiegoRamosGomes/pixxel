import { config } from '../config.js';
import { logger } from '../logger.js';

const BASE = 'https://api.clickup.com/api/v2';

// ClickUp priority numbers (lower = more urgent)
const PRIORITY_LABEL: Record<string, string> = {
  '1': 'urgente',
  '2': 'alta',
  '3': 'normal',
  '4': 'baixa',
};

export type ClickupTask = {
  id: string;
  custom_id?: string | null;
  name: string;
  description?: string;
  text_content?: string;
  status?: { status: string; type?: string };
  priority?: { id: string; priority: string } | null;
  url: string;
  date_updated?: string;
  due_date?: string | null;
  list?: { id: string; name: string };
  folder?: { id: string; name: string };
  space?: { id: string; name: string };
};

export type ClickupComment = {
  id: string;
  comment_text?: string;
  user?: { username?: string };
  date?: string;
};

export const isClickupAvailable = (): boolean => Boolean(config.CLICKUP_TOKEN);

async function clickupFetch<T>(
  path: string,
  params: Record<string, string | string[]> = {},
): Promise<T | null> {
  if (!config.CLICKUP_TOKEN) return null;
  const url = new URL(`${BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
    else url.searchParams.set(k, v);
  }

  try {
    const res = await fetch(url, {
      headers: { Authorization: config.CLICKUP_TOKEN, accept: 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text();
      logger.warn(
        { status: res.status, path, body: body.slice(0, 300) },
        'clickup api error',
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err, path }, 'clickup fetch failed');
    return null;
  }
}

let teamIdCache: string | null = null;
let userIdCache: number | null = null;

async function getTeamId(): Promise<string | null> {
  if (teamIdCache) return teamIdCache;
  const data = await clickupFetch<{ teams: Array<{ id: string }> }>('/team');
  const id = data?.teams[0]?.id ?? null;
  if (id) teamIdCache = id;
  return id;
}

async function getUserId(): Promise<number | null> {
  if (userIdCache) return userIdCache;
  const data = await clickupFetch<{ user: { id: number } }>('/user');
  const id = data?.user?.id ?? null;
  if (id) userIdCache = id;
  return id;
}

const IN_PROGRESS_KEYWORDS = ['progress', 'desenvolv', 'doing', 'andamento'];

function isInProgress(task: ClickupTask): boolean {
  const status = task.status?.status?.toLowerCase() ?? '';
  return IN_PROGRESS_KEYWORDS.some((k) => status.includes(k));
}

/** Tasks atribuídas ao usuário com status que indica "em progresso/desenvolvimento". */
export async function listMyInProgressTasks(): Promise<ClickupTask[] | null> {
  const teamId = await getTeamId();
  const userId = await getUserId();
  if (!teamId || userId == null) return null;

  const data = await clickupFetch<{ tasks: ClickupTask[] }>(`/team/${teamId}/task`, {
    'assignees[]': String(userId),
    include_closed: 'false',
    subtasks: 'true',
    page: '0',
  });
  if (!data) return null;
  return data.tasks.filter(isInProgress);
}

/** Tasks atribuídas ao usuário com prioridade urgent (1) ou high (2).
 *  O filtro `priorities[]` da API do ClickUp não filtra de forma confiável,
 *  então puxamos todas e filtramos no código. */
export async function listMyHighPriorityTasks(): Promise<ClickupTask[] | null> {
  const teamId = await getTeamId();
  const userId = await getUserId();
  if (!teamId || userId == null) return null;

  const data = await clickupFetch<{ tasks: ClickupTask[] }>(`/team/${teamId}/task`, {
    'assignees[]': String(userId),
    include_closed: 'false',
    subtasks: 'true',
    page: '0',
  });
  if (!data) return null;
  return data.tasks.filter((t) => t.priority?.id === '1' || t.priority?.id === '2');
}

// Hash interno do ClickUp: alfanumérico ~7-9 chars (pode começar com 86xxxx).
const INTERNAL_ID_RE = /^[a-z0-9]{6,12}$/i;

/**
 * Aceita várias formas de identificar uma task:
 *   - "868abc123" (id interno)         → fetch direto
 *   - "DEV-6074"  (custom id completo) → custom_task_ids=true&team_id
 *   - "6074"      (só número)           → prefixa com CLICKUP_TASK_PREFIX se setado
 *
 * Tenta na ordem: como id interno, como custom_id direto, como custom_id prefixado.
 */
export async function getTaskDetails(
  rawId: string,
): Promise<{ task: ClickupTask; comments: ClickupComment[] } | null> {
  const teamId = await getTeamId();
  const candidates = buildIdCandidates(rawId);

  for (const c of candidates) {
    const params: Record<string, string> = { include_subtasks: 'true' };
    if (c.kind === 'custom') {
      if (!teamId) continue;
      params.custom_task_ids = 'true';
      params.team_id = teamId;
    }
    const task = await clickupFetch<ClickupTask>(`/task/${c.id}`, params);
    if (task && task.id) {
      const commentsRes = await clickupFetch<{ comments: ClickupComment[] }>(
        `/task/${task.id}/comment`,
      );
      return { task, comments: commentsRes?.comments ?? [] };
    }
  }
  return null;
}

function buildIdCandidates(rawId: string): Array<{ id: string; kind: 'internal' | 'custom' }> {
  const trimmed = rawId.trim();
  const out: Array<{ id: string; kind: 'internal' | 'custom' }> = [];

  // Caso 1: hash interno típico → tenta como id direto
  if (INTERNAL_ID_RE.test(trimmed) && !trimmed.includes('-') && /[a-z]/i.test(trimmed)) {
    out.push({ id: trimmed, kind: 'internal' });
  }

  // Caso 2: já tem prefixo (XXX-1234) → custom_id direto
  if (/^[A-Z]+-\d+$/i.test(trimmed)) {
    out.push({ id: trimmed.toUpperCase(), kind: 'custom' });
  }

  // Caso 3: só números → prefixa se houver CLICKUP_TASK_PREFIX
  if (/^\d+$/.test(trimmed)) {
    const prefix = config.CLICKUP_TASK_PREFIX?.trim().replace(/-+$/, '');
    if (prefix) out.push({ id: `${prefix.toUpperCase()}-${trimmed}`, kind: 'custom' });
    // Também tenta como id interno cru, caso o ClickUp aceite.
    out.push({ id: trimmed, kind: 'internal' });
  }

  // Fallback: usa o que veio direto, primeiro como custom depois como internal.
  if (out.length === 0) {
    out.push({ id: trimmed, kind: 'custom' });
    out.push({ id: trimmed, kind: 'internal' });
  }
  return out;
}

/** Renderiza uma lista de tasks como texto curto pro TTS. */
export function formatTasksList(tasks: ClickupTask[], emptyMsg: string): string {
  if (tasks.length === 0) return emptyMsg;
  const lines = tasks.slice(0, 10).map((t) => {
    const id = t.custom_id || t.id;
    const status = t.status?.status ? ` [${t.status.status}]` : '';
    const prio = t.priority?.id ? ` (prioridade ${PRIORITY_LABEL[t.priority.id] ?? t.priority.priority})` : '';
    return `• ${t.name}${status}${prio} — ${id}`;
  });
  const total = tasks.length;
  const more = total > 10 ? `\n…e mais ${total - 10}.` : '';
  const header =
    total === 1 ? 'Você tem 1 task:\n' : `Você tem ${total} tasks:\n`;
  return header + lines.join('\n') + more;
}

/** Compila descrição completa de uma task pra ser resumida pelo LLM. */
export function buildTaskBriefing(task: ClickupTask, comments: ClickupComment[]): string {
  const id = task.custom_id || task.id;
  const status = task.status?.status ?? '?';
  const prio = task.priority?.id ? PRIORITY_LABEL[task.priority.id] : 'sem prioridade';
  const desc = task.text_content || task.description || '(sem descrição)';
  const list = task.list?.name ? `Lista: ${task.list.name}` : '';
  const space = task.space?.name ? `Espaço: ${task.space.name}` : '';

  const cmts = comments
    .slice(0, 30)
    .map((c, i) => {
      const who = c.user?.username ?? 'alguém';
      const text = c.comment_text?.trim() ?? '';
      return `[Comentário ${i + 1} — ${who}]: ${text}`;
    })
    .join('\n\n');

  return [
    `ID: ${id}`,
    `Título: ${task.name}`,
    `Status: ${status} | Prioridade: ${prio}`,
    [list, space].filter(Boolean).join(' | '),
    '',
    'Descrição:',
    desc,
    '',
    cmts ? 'Comentários:' : '(sem comentários)',
    cmts,
  ]
    .filter((line) => line !== null)
    .join('\n');
}
