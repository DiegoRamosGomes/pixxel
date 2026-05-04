// Orquestra a execução do `claude -p` em subprocess: levanta o MCP de
// permissão, escreve mcp-config, faz spawn do CLI, parseia stream-json
// linha-a-linha e empurra eventos pra fora via callbacks.
//
// Uma execução por vez. Tentativa de start enquanto rodando → erro.

import { spawn, ChildProcess } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startPermissionMcp, type McpServerHandle, type PermissionRequest } from './mcp-server.js';

export type ClaudeRunCallbacks = {
  onState: (state: ClaudeRunState) => void;
  onAssistantText: (delta: string) => void;
  onToolUse: (tool: string, input: unknown) => void;
  onPermissionRequest: (req: PermissionRequest) => void;
  /** Texto final consolidado (ou erro). */
  onResult: (result: { ok: boolean; text: string }) => void;
  /** session_id capturado do init — pra retomar via --resume depois. */
  onSessionId?: (sessionId: string, cwd: string) => void;
};

export type ClaudeRunState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'running' }
  | { kind: 'done' }
  | { kind: 'error'; reason: string };

export type StartOptions = {
  prompt: string;
  /** Diretório em que o claude vai operar (cwd). */
  cwd: string;
  /** Tools pré-aprovadas — não disparam ask_user. */
  allowedTools?: string[];
};

const DEFAULT_ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'LS'];

export class ClaudeRunner {
  private state: ClaudeRunState = { kind: 'idle' };
  private proc: ChildProcess | null = null;
  private mcp: McpServerHandle | null = null;
  private configDir: string | null = null;
  private buffer = '';
  private finalText = '';
  // Marca se vimos QUALQUER output do claude (assistant text, tool_use, ou
  // result) na run atual. Usado pra detectar "morreu antes de produzir nada"
  // — provável sessão inválida quando combinado com --resume.
  private sawAnyOutput = false;
  // Opts da run em andamento — guardadas pra retry sem --resume quando o
  // claude morre antes de produzir saída.
  private currentOpts: StartOptions | null = null;
  // Já tentamos retry sem --resume nesta run? Garante 1 retry só.
  private retriedWithoutResume = false;
  // Sessões Claude por projeto (cwd). Capturadas do system/init e reusadas
  // via --resume. Mantém uma por projeto pra "ir e voltar" preservar contexto.
  // claude indexa session files por cwd (~/.claude/projects/<cwd>/<id>.jsonl),
  // então só dá pra retomar com o mesmo cwd da run original.
  private sessionsByCwd = new Map<string, string>();
  // cwd da run em andamento — usado pra saber sob qual chave gravar o
  // session_id quando o init chega.
  private activeCwd: string | null = null;

  constructor(private readonly cb: ClaudeRunCallbacks) {}

  isRunning(): boolean {
    return this.state.kind === 'starting' || this.state.kind === 'running';
  }

  resolvePermission(requestId: string, allowed: boolean): void {
    this.mcp?.resolvePermission(requestId, { allowed });
  }

  /** Esquece a sessão do projeto ativo — próximo start nele começa do zero. */
  resetSession(cwd?: string): void {
    const key = cwd ?? this.activeCwd;
    if (key) this.sessionsByCwd.delete(key);
  }

  hasSession(cwd: string): boolean {
    return this.sessionsByCwd.has(cwd);
  }

  async start(opts: StartOptions): Promise<{ ok: boolean; reason?: string }> {
    if (this.isRunning()) return { ok: false, reason: 'claude já está rodando' };

    this.setState({ kind: 'starting' });
    this.finalText = '';
    this.buffer = '';
    this.sawAnyOutput = false;
    this.currentOpts = opts;
    this.retriedWithoutResume = false;

    try {
      // 1. Sobe o MCP HTTP
      this.mcp = await startPermissionMcp({
        onPermissionRequest: (req) => this.cb.onPermissionRequest(req),
      });

      // 2. Escreve mcp-config.json em pasta temp (apagada no stop)
      this.configDir = await mkdtemp(path.join(tmpdir(), 'pixxel-claude-'));
      const configPath = path.join(this.configDir, 'mcp-config.json');
      const config = {
        mcpServers: {
          voice: { type: 'http', url: this.mcp.url },
        },
      };
      await writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

      // 3. Spawn do claude
      const allowed = (opts.allowedTools ?? DEFAULT_ALLOWED_TOOLS).join(',');
      const args = [
        '-p',
        opts.prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--mcp-config',
        configPath,
        '--permission-prompt-tool',
        'mcp__voice__ask_user',
        '--allowedTools',
        allowed,
      ];
      this.activeCwd = opts.cwd;
      const savedSession = this.sessionsByCwd.get(opts.cwd);
      if (savedSession) {
        // Continua a conversa anterior NESTE projeto (claude indexa session
        // files por cwd, então --resume só funciona quando cwd bate).
        args.push('--resume', savedSession);
        console.log(`[claude] resumindo sessão ${savedSession} em ${opts.cwd}`);
      }

      const proc = spawn('claude', args, {
        cwd: opts.cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.proc = proc;

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => this.onStdoutChunk(chunk));
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (chunk: string) => {
        // stderr do claude inclui logs/avisos. Logar pra debug, não quebra fluxo.
        console.warn('[claude stderr]', chunk.trim());
      });

      proc.on('error', (err) => {
        console.error('[claude] spawn error', err);
        this.setState({ kind: 'error', reason: err.message });
        this.cb.onResult({ ok: false, text: `Erro: ${err.message}` });
        void this.cleanup();
      });

      proc.on('close', (code) => {
        // Drena qualquer linha residual no buffer
        if (this.buffer.trim()) {
          this.handleEvent(this.buffer.trim());
          this.buffer = '';
        }
        // Retry sem --resume: claude morreu antes de produzir output e estávamos
        // tentando retomar. Sessão provavelmente sumiu (limpeza, atualização do
        // CLI). Esquece a sessão e tenta uma vez do zero.
        const usedResume = !!savedSession;
        const shouldRetry =
          code !== 0 &&
          usedResume &&
          !this.sawAnyOutput &&
          !this.retriedWithoutResume &&
          this.currentOpts !== null;
        if (shouldRetry) {
          console.warn(
            `[claude] saiu com código ${code} sem produzir output usando --resume. ` +
              `Esquecendo sessão e tentando do zero.`,
          );
          this.retriedWithoutResume = true;
          const retryOpts = this.currentOpts!;
          if (this.activeCwd) this.sessionsByCwd.delete(this.activeCwd);
          // Limpa estado pra start() não barrar com isRunning(). Cleanup
          // do mcp/configDir antes de subir tudo de novo.
          this.setState({ kind: 'idle' });
          void this.cleanup().then(() => {
            void this.start(retryOpts);
          });
          return;
        }
        if (this.state.kind === 'error') {
          // Já reportado
        } else if (code === 0) {
          this.setState({ kind: 'done' });
          this.cb.onResult({
            ok: true,
            text: this.finalText || '(sem texto)',
          });
        } else {
          const reason = `claude saiu com código ${code}`;
          this.setState({ kind: 'error', reason });
          this.cb.onResult({ ok: false, text: reason });
        }
        void this.cleanup();
      });

      this.setState({ kind: 'running' });
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'falha desconhecida';
      this.setState({ kind: 'error', reason });
      await this.cleanup();
      return { ok: false, reason };
    }
  }

  async cancel(): Promise<void> {
    // Captura ref local: se um novo start() acontecer enquanto o SIGKILL
    // tá agendado, `this.proc` já vai apontar pro NOVO processo — sem essa
    // captura, o SIGKILL mataria o processo errado (race que se manifestava
    // como "claude saiu com código null" 1-2s após cancelar a anterior).
    const proc = this.proc;
    if (!proc) return;
    proc.kill('SIGTERM');
    // Aguarda close pra cancel ser de fato síncrono pro chamador. Sem isso,
    // o handler do claude_cancel_task voltava antes do close rodar, e o
    // próximo claude_code_task podia spawnar enquanto o antigo ainda
    // disparava cleanup → estados se sobrepondo.
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL');
      }, 2000);
      proc.once('close', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  private async cleanup(): Promise<void> {
    if (this.mcp) {
      try {
        await this.mcp.close();
      } catch (err) {
        console.warn('[claude] mcp close error', err);
      }
      this.mcp = null;
    }
    if (this.configDir) {
      try {
        await rm(this.configDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
      this.configDir = null;
    }
    this.proc = null;
  }

  private setState(next: ClaudeRunState): void {
    this.state = next;
    this.cb.onState(next);
  }

  private onStdoutChunk(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.handleEvent(line);
    }
  }

  private handleEvent(line: string): void {
    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      console.warn('[claude] linha não-JSON ignorada:', line.slice(0, 200));
      return;
    }
    if (!evt || typeof evt !== 'object') return;

    const e = evt as Record<string, unknown>;
    const type = e.type;

    // stream-json do claude: type pode ser system | assistant | user | result
    if (type === 'assistant') {
      this.sawAnyOutput = true;
      const message = e.message as { content?: Array<Record<string, unknown>> } | undefined;
      const content = message?.content ?? [];
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          this.finalText += block.text;
          this.cb.onAssistantText(block.text);
        } else if (block.type === 'tool_use') {
          const name = String(block.name ?? '?');
          this.cb.onToolUse(name, block.input ?? {});
        }
      }
    } else if (type === 'result') {
      this.sawAnyOutput = true;
      // O `result` final pode trazer um texto consolidado em e.result (string).
      const finalResult = typeof e.result === 'string' ? e.result : '';
      if (finalResult) this.finalText = finalResult;
    } else if (type === 'system' && e.subtype === 'init') {
      // Captura session_id e grava sob o cwd ativo pra reusar com --resume.
      // Sobrescreve sempre — se claude mudar o id (ex: --resume cria um id
      // novo continuando a conversa), queremos manter o mais recente.
      const sid = typeof e.session_id === 'string' ? e.session_id : null;
      if (sid && this.activeCwd) {
        this.sessionsByCwd.set(this.activeCwd, sid);
        console.log(`[claude] sessão ${sid} salva pra ${this.activeCwd}`);
        this.cb.onSessionId?.(sid, this.activeCwd);
      }
    }
    // user: ignorado no MVP — carrega tool_result, podemos mostrar depois.
  }
}
