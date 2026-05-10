import { EventEmitter } from 'node:events';
import type { ClaudeSessionChunk, ClaudeSessionView, ClaudeSessionStatus } from '../../shared/ipc.js';
import { ClaudeRunner, isPixxelProject, newSessionId, type PermissionMode } from './runner.js';
import { getSessionStore, SessionStore } from './sessions.js';
import type { ClaudeSession } from './types.js';

export interface StartTaskInput {
  task: string;
  cwd: string;
  project: string | null;
  /** Score 1-10 atribuído pelo Gemini. Default: 5. ≥7 dispara plan-first. */
  complexity?: number;
  appendSystemPrompt?: string;
}

export type StartTaskResult =
  | { ok: true; sessionId: string; queued?: false; mode: 'plan' | 'execute' }
  | { ok: true; sessionId: string; queued: true; position: number; mode: 'plan' | 'execute' }
  | { ok: false; reason: string };

export interface CancelTarget {
  sessionId?: string;
  project?: string;
  all?: boolean;
}

export type CancelResult =
  | { ok: true; cancelled: ClaudeSessionView[]; queueDiscarded: number; rejected: ClaudeSessionView[] }
  | { ok: false; reason: 'no_running'; running: ClaudeSessionView[] }
  | { ok: false; reason: 'ambiguous'; running: ClaudeSessionView[] }
  | { ok: false; reason: 'not_found'; running: ClaudeSessionView[] };

export interface PlanTarget {
  sessionId?: string;
  project?: string;
}

export type PlanActionResult =
  | { ok: true; session: ClaudeSessionView }
  | { ok: false; reason: 'no_awaiting' | 'ambiguous' | 'not_found' | 'spawn_failed'; awaiting?: ClaudeSessionView[]; detail?: string };

interface ManagerEvents {
  session_started: (view: ClaudeSessionView) => void;
  session_chunk: (sessionId: string, chunk: ClaudeSessionChunk) => void;
  session_status: (sessionId: string, status: ClaudeSessionStatus) => void;
  session_done: (
    sessionId: string,
    ok: boolean,
    finalText: string,
    project: string | null,
    cancelled: boolean,
  ) => void;
  plan_ready: (sessionId: string, project: string | null, plan: string) => void;
}

interface QueuedTask {
  sessionId: string;
  task: string;
  cwd: string;
  project: string | null;
  complexity?: number;
  appendSystemPrompt?: string;
  mode: 'plan' | 'execute';
  resume?: boolean;
}

interface ActiveRun {
  runner: ClaudeRunner;
  finalText: string;
  mode: 'plan' | 'execute';
}

const MAX_PARALLEL = 3;
const MAX_QUEUE = 5;
const PLAN_THRESHOLD = 7;

/**
 * Fase 3: roteamento por complexidade.
 *
 * Pixxel project (auto-modificação): sempre `acceptEdits` direto.
 * Outros projetos:
 *   - complexity ≤ 6 → `acceptEdits` direto
 *   - complexity ≥ 7 → modo plan-first: roda `--permission-mode plan`,
 *     captura plano, marca sessão `awaiting_approval`, emite `plan_ready`.
 *     Aprovação resume a sessão com `--permission-mode acceptEdits`.
 */
export class ClaudeManager extends EventEmitter {
  private store: SessionStore;
  private runs = new Map<string, ActiveRun>();
  private queue: QueuedTask[] = [];

  constructor() {
    super();
    this.store = getSessionStore();
  }

  on<E extends keyof ManagerEvents>(event: E, listener: ManagerEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<E extends keyof ManagerEvents>(event: E, ...args: Parameters<ManagerEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  async init(): Promise<void> {
    await this.store.load();
    const crashed = await this.store.reconcileOnBoot();
    if (crashed.length > 0) {
      console.log(`[claude/manager] ${crashed.length} sessão(ões) marcadas como crashed no boot`);
      for (const s of crashed) this.emit('session_status', s.sessionId, 'crashed');
    }
  }

  snapshot(): ClaudeSessionView[] {
    return this.store.active().map(toView);
  }

  running(): ClaudeSessionView[] {
    return this.store
      .active()
      .filter((s) => s.status === 'running')
      .map(toView);
  }

  awaiting(): ClaudeSessionView[] {
    return this.store
      .active()
      .filter((s) => s.status === 'awaiting_approval')
      .map(toView);
  }

  crashed(): ClaudeSessionView[] {
    return this.store
      .active()
      .filter((s) => s.status === 'crashed')
      .map(toView);
  }

  queueLength(): number {
    return this.queue.length;
  }

  async start(input: StartTaskInput): Promise<StartTaskResult> {
    const sessionId = newSessionId();
    const mode = pickMode(input);

    if (this.runs.size >= MAX_PARALLEL) {
      if (this.queue.length >= MAX_QUEUE) {
        return { ok: false, reason: `fila cheia (${MAX_QUEUE} tarefas)` };
      }
      this.queue.push({
        sessionId,
        task: input.task,
        cwd: input.cwd,
        project: input.project,
        complexity: input.complexity,
        appendSystemPrompt: input.appendSystemPrompt,
        mode,
      });
      console.log(
        `[claude/manager] enfileirado (pos ${this.queue.length}, mode=${mode}): "${input.task.slice(0, 60)}"`,
      );
      return { ok: true, sessionId, queued: true, position: this.queue.length, mode };
    }

    const r = await this.spawn({
      sessionId,
      task: input.task,
      cwd: input.cwd,
      project: input.project,
      complexity: input.complexity,
      appendSystemPrompt: input.appendSystemPrompt,
      mode,
    });
    if (!r.ok) return r;
    return { ok: true, sessionId, mode };
  }

  /**
   * Aprova um plano awaiting → resume com acceptEdits e executa.
   * Sem target + 1 awaiting: aprova essa. Sem + várias: ambiguous.
   */
  async approvePlan(target: PlanTarget = {}): Promise<PlanActionResult> {
    const picked = this.pickAwaiting(target);
    if ('ok' in picked) return picked;
    const found = picked.session;

    const r = await this.spawn({
      sessionId: found.sessionId,
      task: 'Aprovado. Execute o plano que você acabou de propor.',
      cwd: found.cwd,
      project: found.project,
      mode: 'execute',
      resume: true,
    });
    if (!r.ok) {
      return { ok: false, reason: 'spawn_failed', detail: r.reason };
    }
    return { ok: true, session: toView(found) };
  }

  /**
   * Revisa um plano awaiting: re-spawn em modo plan com `--resume`, prompt
   * inclui o feedback do usuário. Volta a `awaiting_approval` com plano novo.
   * Contexto preservado (Claude lembra do que já leu/raciocinou).
   */
  async revisePlan(feedback: string, target: PlanTarget = {}): Promise<PlanActionResult> {
    const picked = this.pickAwaiting(target);
    if ('ok' in picked) return picked;
    const found = picked.session;

    const r = await this.spawn({
      sessionId: found.sessionId,
      task:
        `Revise o plano anterior incorporando este feedback do usuário:\n\n` +
        `"${feedback.trim()}"\n\n` +
        `Apresente o plano ATUALIZADO. Mantenha do plano anterior tudo que ` +
        `não conflita com o feedback. Não execute nada — só planeje.`,
      cwd: found.cwd,
      project: found.project,
      mode: 'plan',
      resume: true,
    });
    if (!r.ok) {
      return { ok: false, reason: 'spawn_failed', detail: r.reason };
    }
    return { ok: true, session: toView(found) };
  }

  /** Rejeita um plano awaiting → marca como `done` (terminou intencionalmente) e move pra history. */
  async rejectPlan(target: PlanTarget = {}): Promise<PlanActionResult> {
    const picked = this.pickAwaiting(target);
    if ('ok' in picked) return picked;
    const found = picked.session;
    await this.store.finish(found.sessionId, 'done');
    this.emit('session_done', found.sessionId, false, '', found.project, true);
    this.maybeStartNext();
    return { ok: true, session: toView(found) };
  }

  async cancel(target: CancelTarget = {}): Promise<CancelResult> {
    const runningViews = this.running();
    const awaitingViews = this.awaiting();

    if (target.all) {
      const cancelled: ClaudeSessionView[] = [];
      const rejected: ClaudeSessionView[] = [];
      const queueDiscarded = this.queue.length;
      this.queue.length = 0;
      // Cancela runners ativos
      const runningIds = Array.from(this.runs.keys());
      for (const id of runningIds) {
        const r = this.runs.get(id);
        const view = this.store.get(id);
        if (r && view) {
          await r.runner.cancel();
          cancelled.push(toView(view));
        }
      }
      // Rejeita awaiting (planos pendentes) → done em history.
      for (const view of awaitingViews) {
        const session = this.store.get(view.sessionId);
        if (!session) continue;
        await this.store.finish(view.sessionId, 'done');
        this.emit('session_done', view.sessionId, false, '', view.project, true);
        rejected.push(view);
      }
      return { ok: true, cancelled, queueDiscarded, rejected };
    }

    if (target.sessionId) {
      const r = this.runs.get(target.sessionId);
      const view = this.store.get(target.sessionId);
      if (r && view) {
        await r.runner.cancel();
        return { ok: true, cancelled: [toView(view)], queueDiscarded: 0, rejected: [] };
      }
      // Talvez seja awaiting → trata como rejeição (done em history).
      if (view && view.status === 'awaiting_approval') {
        await this.store.finish(view.sessionId, 'done');
        this.emit('session_done', view.sessionId, false, '', view.project, true);
        return { ok: true, cancelled: [], queueDiscarded: 0, rejected: [toView(view)] };
      }
      return { ok: false, reason: 'not_found', running: runningViews };
    }

    if (target.project) {
      const allCandidates = [...runningViews, ...awaitingViews];
      const matches = matchByProject(allCandidates, target.project);
      if (matches.length === 0) {
        return { ok: false, reason: 'not_found', running: runningViews };
      }
      if (matches.length > 1) {
        return { ok: false, reason: 'ambiguous', running: matches };
      }
      const id = matches[0].sessionId;
      const r = this.runs.get(id);
      const view = this.store.get(id);
      if (r && view) {
        await r.runner.cancel();
        return { ok: true, cancelled: [toView(view)], queueDiscarded: 0, rejected: [] };
      }
      if (view && view.status === 'awaiting_approval') {
        await this.store.finish(view.sessionId, 'done');
        this.emit('session_done', view.sessionId, false, '', view.project, true);
        return { ok: true, cancelled: [], queueDiscarded: 0, rejected: [toView(view)] };
      }
      return { ok: false, reason: 'not_found', running: runningViews };
    }

    // Sem target.
    const totalCandidates = runningViews.length + awaitingViews.length;
    if (totalCandidates === 0) return { ok: false, reason: 'no_running', running: [] };
    if (totalCandidates === 1) {
      if (runningViews.length === 1) {
        const id = runningViews[0].sessionId;
        const r = this.runs.get(id);
        if (!r) return { ok: false, reason: 'not_found', running: runningViews };
        await r.runner.cancel();
        return { ok: true, cancelled: [runningViews[0]], queueDiscarded: 0, rejected: [] };
      }
      // 1 awaiting
      const view = awaitingViews[0];
      await this.store.finish(view.sessionId, 'done');
      this.emit('session_done', view.sessionId, false, '', view.project, true);
      return { ok: true, cancelled: [], queueDiscarded: 0, rejected: [view] };
    }
    return { ok: false, reason: 'ambiguous', running: [...runningViews, ...awaitingViews] };
  }

  /** Sessões retomáveis: paused (cancel manual) + crashed (pid morreu no boot anterior). */
  resumable(): ClaudeSessionView[] {
    return this.store
      .active()
      .filter((s) => s.status === 'paused' || s.status === 'crashed')
      .map(toView);
  }

  /**
   * Retoma sessões `paused` ou `crashed` — re-spawn em execute com `--resume`,
   * mantendo session-id e contexto. Prompt curto explica o motivo da pausa
   * pro Claude decidir o que fazer.
   *
   * target: omitido + 1 retomável → retoma essa. omitido + várias → ambiguous.
   *         "all" → retoma todas. project/sessionId → match.
   */
  async resumeCrashed(target: CancelTarget = {}): Promise<{
    ok: boolean;
    resumed: ClaudeSessionView[];
    failed: Array<{ session: ClaudeSessionView; reason: string }>;
    reason?: 'no_crashed' | 'ambiguous' | 'not_found';
    crashed?: ClaudeSessionView[];
  }> {
    const candidates = this.resumable();

    let toResume: ClaudeSessionView[] = [];

    if (target.all) {
      toResume = candidates;
    } else if (target.sessionId) {
      const found = candidates.find((s) => s.sessionId === target.sessionId);
      if (!found) return { ok: false, resumed: [], failed: [], reason: 'not_found', crashed: candidates };
      toResume = [found];
    } else if (target.project) {
      const matches = matchByProject(candidates, target.project);
      if (matches.length === 0) {
        return { ok: false, resumed: [], failed: [], reason: 'not_found', crashed: candidates };
      }
      if (matches.length > 1) {
        return { ok: false, resumed: [], failed: [], reason: 'ambiguous', crashed: matches };
      }
      toResume = matches;
    } else {
      if (candidates.length === 0) {
        return { ok: false, resumed: [], failed: [], reason: 'no_crashed' };
      }
      if (candidates.length > 1) {
        return { ok: false, resumed: [], failed: [], reason: 'ambiguous', crashed: candidates };
      }
      toResume = candidates;
    }

    const resumed: ClaudeSessionView[] = [];
    const failed: Array<{ session: ClaudeSessionView; reason: string }> = [];
    for (const view of toResume) {
      const session = this.store.get(view.sessionId);
      if (!session) continue;
      const wasCrashed = session.status === 'crashed';
      const reason = wasCrashed
        ? 'o processo morreu inesperadamente'
        : 'o usuário cancelou no meio';
      const r = await this.spawn({
        sessionId: session.sessionId,
        task:
          `Esta sessão foi pausada (${reason}). Continue de onde parou: revise o que já ` +
          `foi feito no projeto, identifique o que ainda falta da tarefa original e termine. ` +
          `Tarefa original: "${session.taskDescription}".`,
        cwd: session.cwd,
        project: session.project,
        mode: 'execute',
        resume: true,
      });
      if (r.ok) resumed.push(view);
      else failed.push({ session: view, reason: r.reason });
    }
    return { ok: true, resumed, failed };
  }

  /**
   * Descarta sessões `paused`/`crashed` sem retomar — marca como `done`
   * (terminou intencionalmente) e move pra history.
   */
  async dismissCrashed(target: CancelTarget = {}): Promise<{
    ok: boolean;
    dismissed: ClaudeSessionView[];
    reason?: 'no_crashed' | 'ambiguous' | 'not_found';
    crashed?: ClaudeSessionView[];
  }> {
    const candidates = this.resumable();

    let toDismiss: ClaudeSessionView[] = [];
    if (target.all) {
      toDismiss = candidates;
    } else if (target.sessionId) {
      const found = candidates.find((s) => s.sessionId === target.sessionId);
      if (!found) return { ok: false, dismissed: [], reason: 'not_found', crashed: candidates };
      toDismiss = [found];
    } else if (target.project) {
      const matches = matchByProject(candidates, target.project);
      if (matches.length === 0) {
        return { ok: false, dismissed: [], reason: 'not_found', crashed: candidates };
      }
      if (matches.length > 1) {
        return { ok: false, dismissed: [], reason: 'ambiguous', crashed: matches };
      }
      toDismiss = matches;
    } else {
      if (candidates.length === 0) return { ok: false, dismissed: [], reason: 'no_crashed' };
      if (candidates.length > 1) return { ok: false, dismissed: [], reason: 'ambiguous', crashed: candidates };
      toDismiss = candidates;
    }

    const dismissed: ClaudeSessionView[] = [];
    for (const view of toDismiss) {
      await this.store.finish(view.sessionId, 'done');
      this.emit('session_done', view.sessionId, false, '', view.project, true);
      dismissed.push(view);
    }
    return { ok: true, dismissed };
  }

  async shutdown(): Promise<void> {
    if (this.runs.size === 0) return;
    console.log(`[claude/manager] shutdown: cancelando ${this.runs.size} sessão(ões)`);
    this.queue.length = 0;
    await Promise.all(Array.from(this.runs.values()).map((r) => r.runner.cancel()));
  }

  // -------- internal --------

  private pickAwaiting(target: PlanTarget): { session: ClaudeSession } | PlanActionResult {
    const awaitingList = this.store.active().filter((s) => s.status === 'awaiting_approval');
    if (awaitingList.length === 0) return { ok: false, reason: 'no_awaiting' };

    if (target.sessionId) {
      const found = awaitingList.find((s) => s.sessionId === target.sessionId);
      if (!found) return { ok: false, reason: 'not_found', awaiting: awaitingList.map(toView) };
      return { session: found };
    }
    if (target.project) {
      const matches = matchByProject(awaitingList.map(toView), target.project);
      if (matches.length === 0) return { ok: false, reason: 'not_found', awaiting: awaitingList.map(toView) };
      if (matches.length > 1) return { ok: false, reason: 'ambiguous', awaiting: matches };
      const found = awaitingList.find((s) => s.sessionId === matches[0].sessionId);
      if (!found) return { ok: false, reason: 'not_found', awaiting: awaitingList.map(toView) };
      return { session: found };
    }
    if (awaitingList.length > 1) {
      return { ok: false, reason: 'ambiguous', awaiting: awaitingList.map(toView) };
    }
    return { session: awaitingList[0] };
  }

  private async spawn(args: {
    sessionId: string;
    task: string;
    cwd: string;
    project: string | null;
    complexity?: number;
    appendSystemPrompt?: string;
    mode: 'plan' | 'execute';
    resume?: boolean;
  }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { sessionId, mode, resume } = args;
    const now = new Date().toISOString();
    const isPixxel = isPixxelProject(args.cwd);
    const permissionMode: PermissionMode =
      mode === 'plan' ? 'plan' : isPixxel ? 'bypassPermissions' : 'acceptEdits';

    const existing = this.store.get(sessionId);
    const session: ClaudeSession = existing
      ? { ...existing, status: 'running', updatedAt: now, permissionMode, pendingPlan: undefined }
      : {
          sessionId,
          cwd: args.cwd,
          project: args.project,
          taskDescription: args.task,
          status: 'running',
          createdAt: now,
          updatedAt: now,
          pid: null,
          permissionMode,
          complexity: args.complexity,
        };
    await this.store.upsert(session);

    const runner = new ClaudeRunner();
    const run: ActiveRun = { runner, finalText: '', mode };
    this.runs.set(sessionId, run);

    // Sessão "started" só emite na primeira vez (modo plan inicial ou execute direto).
    if (!resume) this.emit('session_started', toView(session));
    else this.emit('session_status', sessionId, 'running');

    runner.on('spawn', (pid) => {
      void this.store.updateStatus(sessionId, 'running', pid);
    });

    runner.on('event', (ev) => {
      switch (ev.kind) {
        case 'system_init':
          if (ev.sessionId && ev.sessionId !== sessionId) {
            console.warn(
              `[claude/manager] sessionId divergente em ${sessionId}! recebido=${ev.sessionId}`,
            );
          }
          break;
        case 'assistant_text':
          run.finalText += ev.text;
          this.emit('session_chunk', sessionId, { kind: 'assistant', text: ev.text });
          break;
        case 'tool_use':
          this.emit('session_chunk', sessionId, {
            kind: 'tool_use',
            text: summarizeToolInput(ev.tool, ev.input),
            tool: ev.tool,
          });
          break;
        case 'tool_result':
          this.emit('session_chunk', sessionId, {
            kind: 'tool_result',
            text: ev.content.slice(0, 500),
          });
          break;
        case 'result':
          if (ev.text) run.finalText = ev.text;
          break;
        case 'error':
          this.emit('session_chunk', sessionId, { kind: 'error', text: ev.message });
          break;
      }
    });

    runner.on('stderr', (line) => {
      console.warn(`[claude/runner stderr ${sessionId.slice(0, 8)}] ${line}`);
    });

    runner.on('exit', (code) => {
      const wasCancelled = runner.wasCancelled();
      const finalText = run.finalText;
      const project = session.project;
      this.runs.delete(sessionId);

      // Plan mode terminou com sucesso → guarda plano, status awaiting_approval.
      if (run.mode === 'plan' && code === 0 && !wasCancelled && finalText.trim().length > 0) {
        const sess = this.store.get(sessionId);
        if (sess) {
          sess.status = 'awaiting_approval';
          sess.pendingPlan = finalText;
          sess.updatedAt = new Date().toISOString();
          sess.pid = null;
          void this.store.upsert(sess).then(() => {
            this.emit('session_status', sessionId, 'awaiting_approval');
            this.emit('plan_ready', sessionId, project, finalText);
            this.maybeStartNext();
          });
          return;
        }
      }

      // Cancel manual: mantém em active como `paused` (pode retomar depois).
      // done/failed: finaliza, vai pra history.
      if (wasCancelled) {
        void this.store.markPaused(sessionId).then(() => {
          this.emit('session_status', sessionId, 'paused');
          // session_done com cancelled=true sinaliza UX final, mas a sessão
          // persiste em active aguardando resume manual.
          this.emit('session_done', sessionId, false, finalText, project, true);
          this.maybeStartNext();
        });
        return;
      }
      const finalStatus: ClaudeSessionStatus = code === 0 ? 'done' : 'failed';
      const ok = code === 0;
      void this.store.finish(sessionId, finalStatus).then(() => {
        this.emit('session_done', sessionId, ok, finalText, project, false);
        this.maybeStartNext();
      });
    });

    try {
      runner.start({
        task: args.task,
        cwd: args.cwd,
        sessionId,
        appendSystemPrompt: args.appendSystemPrompt,
        permissionMode,
        resume,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[claude/manager] start falhou:', msg);
      await this.store.finish(sessionId, 'failed');
      this.runs.delete(sessionId);
      this.maybeStartNext();
      return { ok: false, reason: msg };
    }

    return { ok: true };
  }

  private maybeStartNext(): void {
    if (this.runs.size >= MAX_PARALLEL) return;
    const next = this.queue.shift();
    if (!next) return;
    console.log(
      `[claude/manager] desenfileirando (${this.queue.length} restantes, mode=${next.mode}): "${next.task.slice(0, 60)}"`,
    );
    void this.spawn(next);
  }
}

function pickMode(input: StartTaskInput): 'plan' | 'execute' {
  // Pixxel project: sempre execute (auto-modificação, full-auto).
  if (isPixxelProject(input.cwd)) return 'execute';
  const score = input.complexity ?? 5;
  return score >= PLAN_THRESHOLD ? 'plan' : 'execute';
}

function toView(session: ClaudeSession): ClaudeSessionView {
  return {
    sessionId: session.sessionId,
    cwd: session.cwd,
    project: session.project,
    taskDescription: session.taskDescription,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    complexity: session.complexity,
  };
}

function summarizeToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== 'object') return tool;
  const i = input as Record<string, unknown>;
  if (typeof i.file_path === 'string') return `${tool} ${i.file_path}`;
  if (typeof i.command === 'string') return `${tool} ${String(i.command).slice(0, 120)}`;
  if (typeof i.path === 'string') return `${tool} ${i.path}`;
  if (typeof i.pattern === 'string') return `${tool} "${i.pattern}"`;
  return tool;
}

function matchByProject(running: ClaudeSessionView[], query: string): ClaudeSessionView[] {
  const q = query.toLowerCase().trim();
  if (!q) return [];
  const exact = running.filter((s) => (s.project ?? '').toLowerCase() === q);
  if (exact.length > 0) return exact;
  return running.filter((s) => {
    const name = (s.project ?? '').toLowerCase();
    return name.includes(q) || q.includes(name);
  });
}

let singleton: ClaudeManager | null = null;
export function getClaudeManager(): ClaudeManager {
  if (!singleton) singleton = new ClaudeManager();
  return singleton;
}
