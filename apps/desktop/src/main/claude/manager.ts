import { EventEmitter } from 'node:events';
import type { ClaudeSessionChunk, ClaudeSessionView, ClaudeSessionStatus } from '../../shared/ipc.js';
import { ClaudeRunner, newSessionId } from './runner.js';
import { getSessionStore, SessionStore } from './sessions.js';
import type { ClaudeSession } from './types.js';
import { isPixxelProject } from './runner.js';

export interface StartTaskInput {
  task: string;
  cwd: string;
  project: string | null;
  appendSystemPrompt?: string;
}

export type StartTaskResult =
  | { ok: true; sessionId: string }
  | { ok: false; reason: string };

interface ManagerEvents {
  session_started: (view: ClaudeSessionView) => void;
  session_chunk: (sessionId: string, chunk: ClaudeSessionChunk) => void;
  session_status: (sessionId: string, status: ClaudeSessionStatus) => void;
  session_done: (sessionId: string, ok: boolean, finalText: string) => void;
}

/**
 * Fase 1: 1 sessão por vez. Quem chama `start` enquanto outra está running
 * recebe `{ ok: false, reason: 'session_running' }` — sem fila ainda.
 */
export class ClaudeManager extends EventEmitter {
  private store: SessionStore;
  private runner: ClaudeRunner | null = null;
  private currentSessionId: string | null = null;
  private finalText = '';

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

  isBusy(): boolean {
    return this.runner !== null;
  }

  async start(input: StartTaskInput): Promise<StartTaskResult> {
    if (this.runner) {
      return { ok: false, reason: 'session_running' };
    }
    const sessionId = newSessionId();
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
    this.runner = runner;
    this.currentSessionId = sessionId;
    this.finalText = '';

    this.emit('session_started', toView(session));

    runner.on('spawn', (pid) => {
      void this.store.updateStatus(sessionId, 'running', pid);
    });

    runner.on('event', (ev) => {
      switch (ev.kind) {
        case 'system_init':
          // Claude pode reescrever o sessionId? Com --session-id explícito,
          // o init deveria ecoar o mesmo. Logamos divergência se ocorrer.
          if (ev.sessionId && ev.sessionId !== sessionId) {
            console.warn(
              `[claude/manager] sessionId divergente! enviado=${sessionId} recebido=${ev.sessionId}`,
            );
          }
          break;
        case 'assistant_text':
          this.finalText += ev.text;
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
          if (ev.text) this.finalText = ev.text;
          break;
        case 'error':
          this.emit('session_chunk', sessionId, { kind: 'error', text: ev.message });
          break;
      }
    });

    runner.on('stderr', (line) => {
      console.warn(`[claude/runner stderr] ${line}`);
    });

    runner.on('exit', (code) => {
      const wasCancelled = runner.wasCancelled();
      const ok = !wasCancelled && code === 0;
      const finalStatus: ClaudeSessionStatus = wasCancelled
        ? 'paused'
        : code === 0
          ? 'done'
          : 'failed';
      void this.store.finish(sessionId, finalStatus).then(() => {
        this.emit('session_done', sessionId, ok, this.finalText);
      });
      this.runner = null;
      this.currentSessionId = null;
      this.finalText = '';
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
      this.runner = null;
      this.currentSessionId = null;
      return { ok: false, reason: msg };
    }

    return { ok: true, sessionId };
  }

  async cancel(): Promise<{ wasRunning: boolean }> {
    if (!this.runner) return { wasRunning: false };
    await this.runner.cancel();
    return { wasRunning: true };
  }

  /** Para shutdown limpo. */
  async shutdown(): Promise<void> {
    if (this.runner) {
      console.log('[claude/manager] shutdown: cancelando sessão ativa');
      await this.runner.cancel();
    }
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

let singleton: ClaudeManager | null = null;
export function getClaudeManager(): ClaudeManager {
  if (!singleton) singleton = new ClaudeManager();
  return singleton;
}
