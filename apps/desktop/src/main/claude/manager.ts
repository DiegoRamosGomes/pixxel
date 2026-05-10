import { EventEmitter } from 'node:events';
import type { ClaudeSessionChunk, ClaudeSessionView, ClaudeSessionStatus } from '../../shared/ipc.js';
import { ClaudeRunner, isPixxelProject, newSessionId } from './runner.js';
import { getSessionStore, SessionStore } from './sessions.js';
import type { ClaudeSession } from './types.js';

export interface StartTaskInput {
  task: string;
  cwd: string;
  project: string | null;
  appendSystemPrompt?: string;
}

export type StartTaskResult =
  | { ok: true; sessionId: string; queued?: false }
  | { ok: true; sessionId: string; queued: true; position: number }
  | { ok: false; reason: string };

export interface CancelTarget {
  /** Cancela uma sessão específica por ID. */
  sessionId?: string;
  /** Fuzzy match contra project name; cancela a primeira que bater. */
  project?: string;
  /** Cancela todas + esvazia fila. */
  all?: boolean;
}

export type CancelResult =
  | { ok: true; cancelled: ClaudeSessionView[]; queueDiscarded: number }
  | { ok: false; reason: 'no_running'; running: ClaudeSessionView[] }
  | { ok: false; reason: 'ambiguous'; running: ClaudeSessionView[] }
  | { ok: false; reason: 'not_found'; running: ClaudeSessionView[] };

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
}

interface QueuedTask {
  sessionId: string;
  task: string;
  cwd: string;
  project: string | null;
  appendSystemPrompt?: string;
}

interface ActiveRun {
  runner: ClaudeRunner;
  finalText: string;
}

const MAX_PARALLEL = 3;
const MAX_QUEUE = 5;

/**
 * Fase 2: até 3 sessões em paralelo (mistura mesmo projeto + projetos
 * diferentes). 4ª task entra em fila FIFO. Cada subprocess tem seu
 * --session-id próprio — cwd igual entre múltiplas sessões NÃO é problema
 * porque cada uma escreve em ~/.claude/projects/<hash>/<sessionId>.jsonl.
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
      for (const s of crashed) {
        this.emit('session_status', s.sessionId, 'crashed');
      }
    }
  }

  snapshot(): ClaudeSessionView[] {
    return this.store.active().map(toView);
  }

  /** Sessões running agora (excluindo paused/crashed). */
  running(): ClaudeSessionView[] {
    return this.store
      .active()
      .filter((s) => s.status === 'running')
      .map(toView);
  }

  queueLength(): number {
    return this.queue.length;
  }

  async start(input: StartTaskInput): Promise<StartTaskResult> {
    const sessionId = newSessionId();

    if (this.runs.size >= MAX_PARALLEL) {
      if (this.queue.length >= MAX_QUEUE) {
        return { ok: false, reason: `fila cheia (${MAX_QUEUE} tarefas)` };
      }
      this.queue.push({
        sessionId,
        task: input.task,
        cwd: input.cwd,
        project: input.project,
        appendSystemPrompt: input.appendSystemPrompt,
      });
      console.log(
        `[claude/manager] enfileirado (pos ${this.queue.length}): "${input.task.slice(0, 60)}"`,
      );
      // Pré-grava sessão como "paused" só pra existir no store enquanto espera?
      // Não — a fila é volátil. Sessão só vai pro store quando spawnar.
      return { ok: true, sessionId, queued: true, position: this.queue.length };
    }

    return this.spawn({ ...input, sessionId });
  }

  private async spawn(input: StartTaskInput & { sessionId: string }): Promise<StartTaskResult> {
    const { sessionId } = input;
    const now = new Date().toISOString();
    const session: ClaudeSession = {
      sessionId,
      cwd: input.cwd,
      project: input.project,
      taskDescription: input.task,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      pid: null,
      permissionMode: isPixxelProject(input.cwd) ? 'bypassPermissions' : 'acceptEdits',
    };
    await this.store.upsert(session);

    const runner = new ClaudeRunner();
    const run: ActiveRun = { runner, finalText: '' };
    this.runs.set(sessionId, run);

    this.emit('session_started', toView(session));

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
      const ok = !wasCancelled && code === 0;
      const finalStatus: ClaudeSessionStatus = wasCancelled
        ? 'paused'
        : code === 0
          ? 'done'
          : 'failed';
      const finalText = run.finalText;
      const project = session.project;
      void this.store.finish(sessionId, finalStatus).then(() => {
        this.emit('session_done', sessionId, ok, finalText, project, wasCancelled);
        this.runs.delete(sessionId);
        this.maybeStartNext();
      });
    });

    try {
      runner.start({
        task: input.task,
        cwd: input.cwd,
        sessionId,
        appendSystemPrompt: input.appendSystemPrompt,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[claude/manager] start falhou:', msg);
      await this.store.finish(sessionId, 'failed');
      this.runs.delete(sessionId);
      this.maybeStartNext();
      return { ok: false, reason: msg };
    }

    return { ok: true, sessionId };
  }

  private maybeStartNext(): void {
    if (this.runs.size >= MAX_PARALLEL) return;
    const next = this.queue.shift();
    if (!next) return;
    console.log(
      `[claude/manager] desenfileirando (${this.queue.length} restantes): "${next.task.slice(0, 60)}"`,
    );
    void this.spawn(next);
  }

  async cancel(target: CancelTarget = {}): Promise<CancelResult> {
    const runningViews = this.running();

    if (target.all) {
      const cancelled: ClaudeSessionView[] = [];
      const sessionIds = Array.from(this.runs.keys());
      const queueDiscarded = this.queue.length;
      this.queue.length = 0;
      for (const id of sessionIds) {
        const r = this.runs.get(id);
        const view = this.store.get(id);
        if (r && view) {
          await r.runner.cancel();
          cancelled.push(toView(view));
        }
      }
      return { ok: true, cancelled, queueDiscarded };
    }

    if (target.sessionId) {
      const r = this.runs.get(target.sessionId);
      const view = this.store.get(target.sessionId);
      if (!r || !view) {
        return { ok: false, reason: 'not_found', running: runningViews };
      }
      await r.runner.cancel();
      return { ok: true, cancelled: [toView(view)], queueDiscarded: 0 };
    }

    if (target.project) {
      const matches = matchByProject(runningViews, target.project);
      if (matches.length === 0) {
        return { ok: false, reason: 'not_found', running: runningViews };
      }
      // Mais de uma sessão no mesmo projeto: ambíguo, peça desambiguação.
      if (matches.length > 1) {
        return { ok: false, reason: 'ambiguous', running: matches };
      }
      const id = matches[0].sessionId;
      const r = this.runs.get(id);
      if (!r) return { ok: false, reason: 'not_found', running: runningViews };
      await r.runner.cancel();
      return { ok: true, cancelled: [matches[0]], queueDiscarded: 0 };
    }

    // Sem target: cancela só se houver exatamente 1 rodando.
    if (runningViews.length === 0) {
      return { ok: false, reason: 'no_running', running: [] };
    }
    if (runningViews.length === 1) {
      const id = runningViews[0].sessionId;
      const r = this.runs.get(id);
      if (!r) return { ok: false, reason: 'not_found', running: runningViews };
      await r.runner.cancel();
      return { ok: true, cancelled: [runningViews[0]], queueDiscarded: 0 };
    }
    // Mais de uma rodando, sem target → ambíguo, Gemini pergunta.
    return { ok: false, reason: 'ambiguous', running: runningViews };
  }

  async shutdown(): Promise<void> {
    if (this.runs.size === 0) return;
    console.log(`[claude/manager] shutdown: cancelando ${this.runs.size} sessão(ões)`);
    this.queue.length = 0;
    await Promise.all(Array.from(this.runs.values()).map((r) => r.runner.cancel()));
  }
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
  // Match em duas passadas: igualdade exata, depois substring/fuzzy.
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
