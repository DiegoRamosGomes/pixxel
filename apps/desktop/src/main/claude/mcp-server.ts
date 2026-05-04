// MCP server in-process: hospeda a tool `ask_user` que o claude-cli chama
// toda vez que precisa de permissão pra usar uma tool (Bash, Edit, Write...).
// Roda direto no main do Electron via HTTP localhost — sem subprocess separado.
//
// Quando ask_user é invocada, ela emite um pedido pro UI (modal Sim/Não) e
// aguarda a resposta. O claude bloqueia até receber o veredito.

import http from 'node:http';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

// O transport SÓ pode ser reusado entre requests em modo stateful — em
// stateless ele lança "Stateless transport cannot be reused across requests".
// Como nosso server é local e exclusivo do claude que a gente spawna,
// stateful com sessionId aleatório resolve sem complicar.

export type PermissionRequest = {
  requestId: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
};

export type PermissionDecision = { allowed: boolean };

export type McpServerHandle = {
  url: string;
  /** Resolve uma permissão pendente via ID. No-op se ID não bate. */
  resolvePermission: (requestId: string, decision: PermissionDecision) => void;
  close: () => Promise<void>;
};

export type StartMcpOptions = {
  /** Callback chamado quando o claude pede permissão. Deve disparar UI. */
  onPermissionRequest: (req: PermissionRequest) => void;
};

/**
 * Resumo curto pra UI/voz a partir do tool_name + input do claude.
 * Mantém em uma frase. Se o input for grande, trunca.
 */
function summarize(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case 'Bash': {
      const cmd = String(input.command ?? '').trim();
      return cmd ? `Rodar comando: ${truncate(cmd, 160)}` : 'Rodar um comando shell';
    }
    case 'Edit': {
      const path = String(input.file_path ?? input.path ?? '');
      return path ? `Editar arquivo ${basename(path)}` : 'Editar um arquivo';
    }
    case 'Write': {
      const path = String(input.file_path ?? input.path ?? '');
      return path ? `Criar/sobrescrever ${basename(path)}` : 'Escrever um arquivo';
    }
    case 'WebFetch':
    case 'WebSearch': {
      const q = String(input.url ?? input.query ?? '');
      return q ? `${tool} em ${truncate(q, 120)}` : tool;
    }
    default:
      return `Usar ${tool}`;
  }
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

/**
 * Sobe o MCP em uma porta aleatória do localhost. Retorna a URL pra colocar
 * no mcp-config.json e funções pra resolver permissões / encerrar.
 */
export async function startPermissionMcp(opts: StartMcpOptions): Promise<McpServerHandle> {
  // requestId → resolver da Promise pendente. Sem timeout: o usuário decide
  // no seu tempo. Pendências só resolvem em close() (vira deny pra liberar
  // o claude que tá esperando) ou via resolvePermission externo.
  const pending = new Map<string, (d: PermissionDecision) => void>();

  const mcp = new McpServer(
    { name: 'pixxel-voice-permissions', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  mcp.registerTool(
    'ask_user',
    {
      description:
        'Pergunta ao usuário se Claude pode executar uma ação. Use sempre que precisar de permissão.',
      inputSchema: {
        tool_name: z.string().describe('Nome da tool sendo solicitada (ex: Bash, Edit)'),
        input: z
          .record(z.string(), z.unknown())
          .describe('Argumentos completos da tool sendo solicitada'),
      },
    },
    async ({ tool_name, input }) => {
      const requestId = randomUUID();
      const safeInput = (input ?? {}) as Record<string, unknown>;
      const summary = summarize(tool_name, safeInput);

      const decision = await new Promise<PermissionDecision>((resolve) => {
        pending.set(requestId, resolve);
        opts.onPermissionRequest({ requestId, tool: tool_name, input: safeInput, summary });
      });

      const payload = decision.allowed
        ? { behavior: 'allow', updatedInput: safeInput }
        : { behavior: 'deny', message: 'Usuário negou a permissão' };

      return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
    },
  );

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await mcp.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    if (!req.url || !req.url.startsWith('/mcp')) {
      res.statusCode = 404;
      res.end();
      return;
    }
    try {
      // Body precisa ser pré-parseado pra POST com JSON-RPC. Pequeno o suficiente
      // pra carregar inteiro em memória (mensagens MCP são minúsculas).
      let body: unknown = undefined;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        body = raw ? JSON.parse(raw) : undefined;
      }
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error('[mcp] handleRequest error', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'mcp_handler_error' }));
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const port = (httpServer.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/mcp`;

  console.log(`[mcp] permission server up at ${url}`);

  return {
    url,
    resolvePermission(requestId, decision) {
      const resolver = pending.get(requestId);
      if (!resolver) return;
      pending.delete(requestId);
      resolver(decision);
    },
    async close() {
      // Resolve qualquer pendência como deny pra liberar o claude.
      for (const [, resolver] of pending) resolver({ allowed: false });
      pending.clear();
      await transport.close();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
