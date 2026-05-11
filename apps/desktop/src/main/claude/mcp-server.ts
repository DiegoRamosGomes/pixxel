/**
 * MCP server local pro Claude CLI consumir como ferramenta de pergunta-ao-usuário.
 *
 * Substitui o `AskUserQuestion` built-in (que bloqueia indefinidamente em
 * `-p` headless) por uma tool `ask_user` que o Pixxel intercepta — mostra
 * pergunta + opções por voz, captura resposta do usuário, retorna pro Claude.
 *
 * Mesma técnica que a extensão Claude Code do VSCode usa (rodam MCP server
 * local com tool de interação UI).
 *
 * Transport: Streamable HTTP em 127.0.0.1 com porta aleatória.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { z } from 'zod/v4';

export interface AskUserOption {
  label: string;
  description?: string;
}

export interface AskUserQuestion {
  questionId: string;
  /** Sessão Claude que perguntou (vem via _pixxel_session no input, opcional). */
  sessionId: string | null;
  question: string;
  options: AskUserOption[];
}

/**
 * Pedido de permissão roteado pelo CLI `--permission-prompt-tool`. A tool
 * `permission_prompt` resolve uma Promise que decide se a ferramenta original
 * (Bash, Edit, etc.) executa.
 */
export interface PermissionRequest {
  permissionId: string;
  /** Sessão Claude que pediu (vem via _pixxel_session, opcional — heurística cobre). */
  sessionId: string | null;
  /** Nome da tool original (ex: 'Bash', 'Edit'). */
  toolName: string;
  /** Args completos da tool original. */
  toolInput: Record<string, unknown>;
  /** ID da tool_use que o CLI gerou — vai na resposta pra fechar o ciclo. */
  toolUseId: string;
}

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  /** Texto mostrado ao Claude quando deny (ex: "usuário recusou"). */
  message?: string;
  /** Quando allow, opcionalmente substitui o input original antes de executar. */
  updatedInput?: Record<string, unknown>;
}

interface PendingEntry {
  question: AskUserQuestion;
  resolve: (answer: string) => void;
  reject: (reason: Error) => void;
}

interface PendingPermissionEntry {
  request: PermissionRequest;
  resolve: (decision: PermissionDecision) => void;
  reject: (reason: Error) => void;
}

interface McpEvents {
  question_asked: (q: AskUserQuestion) => void;
  permission_requested: (p: PermissionRequest) => void;
}

/**
 * MCP server in-process. Singleton — uma instância serve todas as sessões
 * Claude (a tool `ask_user` aceita `_pixxel_session` opcional pra
 * identificar qual sessão Claude tá perguntando).
 */
export class PixxelMcpServer extends EventEmitter {
  private mcp: McpServer | null = null;
  private httpServer: HttpServer | null = null;
  /**
   * Todas as perguntas pendentes (já aceitas no MCP, ainda não respondidas).
   * Ordem de inserção = ordem de chegada (Map preserva isso).
   */
  private pending = new Map<string, PendingEntry>();
  /**
   * Pergunta atualmente VISÍVEL pro usuário (já emitida via `question_asked`).
   * Fila sequencial: só 1 ativa por vez. Quando resolve/rejeita, a próxima
   * da fila sobe automaticamente.
   *
   * Por que: 2+ perguntas em sessões paralelas confundem o roteamento via voz
   * (Gemini pode errar `target` ao chamar answer_question, mandando resposta
   * pra sessão errada). Serializar é mais seguro — Claude da sessão na fila
   * fica bloqueado no HTTP wait, mas como ele estaria parado mesmo, não piora.
   */
  private activeQuestionId: string | null = null;
  /** Pedidos de permissão pendentes — mesma serialização que `pending`. */
  private permissions = new Map<string, PendingPermissionEntry>();
  private activePermissionId: string | null = null;
  private port = 0;

  on<E extends keyof McpEvents>(event: E, listener: McpEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<E extends keyof McpEvents>(event: E, ...args: Parameters<McpEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  /**
   * Sobe o servidor MCP. Retorna a URL que vai pro `--mcp-config` do `claude` CLI.
   */
  async start(): Promise<{ url: string }> {
    if (this.httpServer) return { url: this.url() };

    this.mcp = new McpServer(
      { name: 'pixxel', version: '1.0.0' },
      { capabilities: {} },
    );

    this.mcp.registerTool(
      'ask_user',
      {
        description:
          'Pergunte ao usuário antes de prosseguir. Use quando precisar de uma decisão durante a tarefa ' +
          '(escolha de biblioteca, abordagem, confirmação destrutiva, esclarecimento ambíguo). ' +
          'A resposta volta como texto. NÃO use pra perguntas hipotéticas — só quando realmente precisar.',
        inputSchema: {
          question: z.string().describe('A pergunta clara, em português.'),
          options: z
            .array(
              z.object({
                label: z.string().describe('Texto curto da opção (1-5 palavras).'),
                description: z.string().optional().describe('Detalhe opcional do que a opção significa.'),
              }),
            )
            .min(2)
            .max(6)
            .describe('Lista de 2-6 opções pro usuário escolher.'),
          _pixxel_session: z
            .string()
            .optional()
            .describe(
              'UUID da sua sessão (vem no system prompt). SEMPRE preencha se souber — ajuda o Pixxel identificar qual tarefa tá perguntando.',
            ),
        },
      },
      async ({ question, options, _pixxel_session }) => {
        const questionId = randomUUID();
        const sessionId = typeof _pixxel_session === 'string' && _pixxel_session.trim()
          ? _pixxel_session.trim()
          : null;
        const q: AskUserQuestion = {
          questionId,
          sessionId,
          question,
          options: options as AskUserOption[],
        };
        const answer = await new Promise<string>((resolve, reject) => {
          this.pending.set(questionId, { question: q, resolve, reject });
          // Fila sequencial: só emite se não houver outra ativa. Senão fica
          // esperando a vez (a Promise não resolve até resolveQuestion).
          if (this.activeQuestionId === null) {
            this.activeQuestionId = questionId;
            console.log(
              `[pixxel-mcp] question ${questionId.slice(0, 8)} virou ativa (fila: ${this.pending.size - 1})`,
            );
            this.emit('question_asked', q);
          } else {
            console.log(
              `[pixxel-mcp] question ${questionId.slice(0, 8)} enfileirada (fila: ${this.pending.size - 1}, ativa: ${this.activeQuestionId.slice(0, 8)})`,
            );
          }
        });
        return {
          content: [{ type: 'text', text: answer }],
        };
      },
    );

    // Roteia pedidos de permissão do CLI (Bash, Edit, Write, etc) — flag
    // `--permission-prompt-tool mcp__pixxel__permission_prompt` faz o CLI
    // chamar essa tool em vez de bloquear. Aguardamos decisão do usuário
    // via voz e devolvemos { behavior, message?, updatedInput? } em JSON
    // dentro de content[0].text — formato exigido pelo CLI.
    this.mcp.registerTool(
      'permission_prompt',
      {
        description:
          'NÃO chame essa tool diretamente — o Claude Code CLI a invoca ' +
          'automaticamente quando precisa de permissão pra executar uma ' +
          'ferramenta. Devolve allow/deny baseado em decisão do usuário.',
        inputSchema: {
          tool_name: z.string(),
          input: z.record(z.string(), z.unknown()),
          tool_use_id: z.string().optional(),
          _pixxel_session: z.string().optional(),
        },
      },
      async ({ tool_name, input, tool_use_id, _pixxel_session }) => {
        const permissionId = randomUUID();
        const sessionId =
          typeof _pixxel_session === 'string' && _pixxel_session.trim()
            ? _pixxel_session.trim()
            : null;
        const req: PermissionRequest = {
          permissionId,
          sessionId,
          toolName: tool_name,
          toolInput: (input ?? {}) as Record<string, unknown>,
          toolUseId: typeof tool_use_id === 'string' ? tool_use_id : '',
        };
        const decision = await new Promise<PermissionDecision>((resolve, reject) => {
          this.permissions.set(permissionId, { request: req, resolve, reject });
          if (this.activePermissionId === null) {
            this.activePermissionId = permissionId;
            console.log(
              `[pixxel-mcp] permission ${permissionId.slice(0, 8)} ativa (tool=${tool_name})`,
            );
            this.emit('permission_requested', req);
          } else {
            console.log(
              `[pixxel-mcp] permission ${permissionId.slice(0, 8)} enfileirada (ativa: ${this.activePermissionId.slice(0, 8)})`,
            );
          }
        });
        // Shape exigido pelo CLI: JSON serializado em content[0].text.
        const payload: Record<string, unknown> = { behavior: decision.behavior };
        if (decision.message) payload.message = decision.message;
        if (decision.updatedInput) payload.updatedInput = decision.updatedInput;
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      },
    );

    const app = express();
    app.use(express.json());

    app.post('/mcp', async (req, res) => {
      try {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless: cada request é independente
          enableJsonResponse: true,
        });
        res.on('close', () => {
          void transport.close();
        });
        await this.mcp!.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch (err) {
        console.warn('[pixxel-mcp] erro:', err);
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
    });

    return new Promise<{ url: string }>((resolve, reject) => {
      this.httpServer = app.listen(0, '127.0.0.1', () => {
        const addr = this.httpServer!.address();
        if (typeof addr === 'object' && addr !== null) {
          this.port = addr.port;
          console.log(`[pixxel-mcp] listening on ${this.url()}`);
          resolve({ url: this.url() });
        } else {
          reject(new Error('failed to get listen address'));
        }
      });
      this.httpServer.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    // Rejeita perguntas pendentes (ativas + na fila) pra Claude não ficar travado.
    for (const entry of this.pending.values()) {
      entry.reject(new Error('mcp server shutting down'));
    }
    this.pending.clear();
    this.activeQuestionId = null;
    // Mesma coisa pra permissões — deny pra liberar o Claude.
    for (const entry of this.permissions.values()) {
      entry.resolve({ behavior: 'deny', message: 'mcp server shutting down' });
    }
    this.permissions.clear();
    this.activePermissionId = null;
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
    this.mcp = null;
  }

  /** URL pro --mcp-config. */
  url(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  /** JSON pro --mcp-config (passado inline como flag). */
  mcpConfigJson(): string {
    return JSON.stringify({
      mcpServers: {
        pixxel: {
          type: 'http',
          url: this.url(),
        },
      },
    });
  }

  /** Lista perguntas atualmente esperando resposta. */
  pendingQuestions(): AskUserQuestion[] {
    return Array.from(this.pending.values()).map((e) => e.question);
  }

  /** Resolve a pergunta com a resposta — Claude continua. Avança fila. */
  resolveQuestion(questionId: string, answer: string): boolean {
    const entry = this.pending.get(questionId);
    if (!entry) return false;
    entry.resolve(answer);
    this.pending.delete(questionId);
    if (this.activeQuestionId === questionId) {
      this.activeQuestionId = null;
      this.promoteNextInQueue();
    }
    return true;
  }

  /** Rejeita a pergunta — Claude recebe erro. Avança fila. */
  rejectQuestion(questionId: string, reason: string): boolean {
    const entry = this.pending.get(questionId);
    if (!entry) return false;
    entry.reject(new Error(reason));
    this.pending.delete(questionId);
    if (this.activeQuestionId === questionId) {
      this.activeQuestionId = null;
      this.promoteNextInQueue();
    }
    return true;
  }

  /** Promove a próxima pergunta da fila pra ativa e emite question_asked. */
  private promoteNextInQueue(): void {
    const next = this.pending.values().next();
    if (next.done) return;
    const entry = next.value;
    this.activeQuestionId = entry.question.questionId;
    console.log(
      `[pixxel-mcp] promovendo question ${entry.question.questionId.slice(0, 8)} (fila restante: ${this.pending.size - 1})`,
    );
    this.emit('question_asked', entry.question);
  }

  // --- Permissões ---

  pendingPermissionsList(): PermissionRequest[] {
    return Array.from(this.permissions.values()).map((e) => e.request);
  }

  resolvePermission(permissionId: string, decision: PermissionDecision): boolean {
    const entry = this.permissions.get(permissionId);
    if (!entry) return false;
    entry.resolve(decision);
    this.permissions.delete(permissionId);
    if (this.activePermissionId === permissionId) {
      this.activePermissionId = null;
      this.promoteNextPermission();
    }
    return true;
  }

  private promoteNextPermission(): void {
    const next = this.permissions.values().next();
    if (next.done) return;
    const entry = next.value;
    this.activePermissionId = entry.request.permissionId;
    console.log(
      `[pixxel-mcp] promovendo permission ${entry.request.permissionId.slice(0, 8)} (fila restante: ${this.permissions.size - 1})`,
    );
    this.emit('permission_requested', entry.request);
  }
}

let singleton: PixxelMcpServer | null = null;
export function getMcpServer(): PixxelMcpServer {
  if (!singleton) singleton = new PixxelMcpServer();
  return singleton;
}
