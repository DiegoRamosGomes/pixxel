import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { resolve as resolvePath } from 'node:path';
import { StreamJsonParser, type ParsedEvent } from './stream-parser.js';

const PIXXEL_PROJECT_PATHS = [
  '/media/diego/Games/Projetos/dk/assistant',
  '/home/diego/Projects/dk/assistant',
];

export type PermissionMode = 'acceptEdits' | 'bypassPermissions' | 'plan';

export interface RunnerOptions {
  task: string;
  cwd: string;
  /** UUID gerado pelo Pixxel — usado pra controlar sessão de fora. */
  sessionId: string;
  /** Resume de uma sessão existente (mesmo sessionId já usado antes). */
  resume?: boolean;
  /** Append no system prompt — usado pra injetar memória/contexto. */
  appendSystemPrompt?: string;
  /** Override do permission mode (default: pixxel project → bypass, outros → acceptEdits). */
  permissionMode?: PermissionMode;
  /** JSON do --mcp-config (inline). Pixxel passa pra Claude ver tool `pixxel__ask_user`. */
  mcpConfigJson?: string;
  /** Lista de tools a desabilitar via --disallowedTools (ex: ['AskUserQuestion']). */
  disallowedTools?: string[];
  /**
   * Nome da tool MCP que vai receber pedidos de permissão (ex:
   * `mcp__pixxel__permission_prompt`). Quando setado, o CLI roteia pedidos
   * de permissão pra essa tool em vez de bloquear/negar silenciosamente.
   */
  permissionPromptTool?: string;
}

export interface RunnerEvents {
  event: (event: ParsedEvent) => void;
  spawn: (pid: number) => void;
  exit: (code: number | null, signal: NodeJS.Signals | null) => void;
  stderr: (line: string) => void;
}

/**
 * Spawna `claude -p` com flags pra streaming, parse linha-a-linha, emite
 * eventos parsed. NÃO mantém estado próprio além do processo — quem chama
 * é responsável por persistir o que importa em `sessions.json`.
 */
export class ClaudeRunner extends EventEmitter {
  private child: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private parser = new StreamJsonParser();
  private cancelled = false;

  on<E extends keyof RunnerEvents>(event: E, listener: RunnerEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<E extends keyof RunnerEvents>(event: E, ...args: Parameters<RunnerEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  start(opts: RunnerOptions): void {
    if (this.child) throw new Error('runner já rodando');
    const permissionMode = opts.permissionMode ?? pickPermissionMode(opts.cwd);
    const args = [
      '-p',
      opts.task,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      permissionMode,
    ];
    // `--session-id` e `--resume` são mutuamente exclusivos sem `--fork-session`.
    // Em resume, o session-id é determinado pelo próprio `--resume <id>`.
    if (opts.resume) {
      args.push('--resume', opts.sessionId);
    } else {
      args.push('--session-id', opts.sessionId);
    }
    if (opts.appendSystemPrompt) args.push('--append-system-prompt', opts.appendSystemPrompt);
    if (opts.mcpConfigJson) args.push('--mcp-config', opts.mcpConfigJson);
    if (opts.disallowedTools && opts.disallowedTools.length > 0) {
      args.push('--disallowedTools', ...opts.disallowedTools);
    }
    if (opts.permissionPromptTool) {
      args.push('--permission-prompt-tool', opts.permissionPromptTool);
    }

    const env = sanitizeEnv(process.env);

    console.log(
      `[claude/runner] spawn cwd=${opts.cwd} sessionId=${opts.sessionId} mode=${permissionMode} task="${opts.task.slice(0, 80)}"`,
    );

    const child = spawn('claude', args, {
      cwd: opts.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.emit('spawn', child.pid ?? 0);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      const events = this.parser.feed(chunk);
      for (const ev of events) this.emit('event', ev);
    });

    child.stderr.on('data', (chunk: string) => {
      for (const line of String(chunk).split('\n')) {
        const t = line.trim();
        if (t) this.emit('stderr', t);
      }
    });

    child.on('error', (err) => {
      console.warn('[claude/runner] erro de spawn:', err);
      this.emit('event', { kind: 'error', message: err.message });
    });

    child.on('exit', (code, signal) => {
      const tail = this.parser.flush();
      for (const ev of tail) this.emit('event', ev);
      this.child = null;
      console.log(`[claude/runner] exit code=${code} signal=${signal} cancelled=${this.cancelled}`);
      this.emit('exit', code, signal);
    });
  }

  async cancel(): Promise<void> {
    if (!this.child) return;
    this.cancelled = true;
    const child = this.child;
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  pid(): number | null {
    return this.child?.pid ?? null;
  }

  wasCancelled(): boolean {
    return this.cancelled;
  }
}

export function isPixxelProject(cwd: string): boolean {
  const real = resolvePath(cwd);
  return PIXXEL_PROJECT_PATHS.some((p) => real === p || real.startsWith(`${p}/`));
}

function pickPermissionMode(cwd: string): PermissionMode {
  return isPixxelProject(cwd) ? 'bypassPermissions' : 'acceptEdits';
}

/**
 * Remove env vars que fariam o `claude` CLI cair em modo "API/billing":
 * subscription Max só é honrada se NENHUMA dessas estiver setada.
 */
function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.AWS_BEARER_TOKEN_BEDROCK;
  return env;
}

export function newSessionId(): string {
  return randomUUID();
}
