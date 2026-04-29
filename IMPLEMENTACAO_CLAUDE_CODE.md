# Plano: Capacidade Claude Code no Jarvis

## Objetivo

Adicionar uma capacidade "Claude Code" ao assistente, reusando a OAuth Pro/Max já logada na CLI (sem API key, sem custo extra). Fluxo final: usuário pede uma tarefa de codar → Jarvis spawna `claude -p` no projeto alvo → Claude pede permissão pra cada tool → Jarvis mostra modal (e fala) → usuário responde → Claude continua → resposta final é falada de volta.

## Estado atual da decisão

- **Diretório alvo:** fixo no projeto `/media/diego/Games/Projetos/dk/assistant` no MVP. Depois vira config; o próprio Claude pode trocar de pasta na sessão dele.
- **Permissões:** modal com botões Sim/Não no MVP. Resposta por voz vem na Fase 3.
- **Disparo:** botão dedicado **e** tool no Gemini Live (`claude_code_task`). Tool entra na Fase 2.
- **CLI:** `claude` v2.1.121 confirmado no PATH, OAuth ok, smoke `claude -p "ping"` retorna `pong`.

## Arquitetura

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer (React)                                             │
│  ┌────────────┐   ┌─────────────┐   ┌────────────────────┐   │
│  │ Painel     │   │ Modal       │   │ Status Claude      │   │
│  │ Claude     │   │ Permissão   │   │ (idle/running/...)│   │
│  └─────┬──────┘   └──────┬──────┘   └──────────┬─────────┘   │
└────────┼─────────────────┼─────────────────────┼─────────────┘
         │ IPC             │ IPC                 │ IPC
┌────────┼─────────────────┼─────────────────────┼─────────────┐
│ Main (Electron)                                              │
│  ┌─────▼─────────────────▼─────────────────────▼─────────┐   │
│  │ ClaudeRunner                                          │   │
│  │  • spawn('claude', ['-p', ...])                       │   │
│  │  • parse stream-json (stdout linha-a-linha)           │   │
│  │  • cancel/kill                                        │   │
│  └────┬────────────────────────────────┬─────────────────┘   │
│       │ stdio                          │ fork()              │
│  ┌────▼─────────┐                ┌─────▼──────────────────┐  │
│  │ claude CLI   │ ◄── MCP ──────►│ voice-permission MCP   │  │
│  │ (subprocess) │   (stdio)      │ (subprocess Node)      │  │
│  └──────────────┘                │  • tool: ask_user      │  │
│                                  │  • IPC com main        │  │
│                                  └────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

**Por que MCP em subprocess separado?** O `claude` precisa conectar a um MCP via stdio (ou SSE/HTTP). O jeito mais simples e isolado é forkar um Node script que carrega `@modelcontextprotocol/sdk` e fala com o Claude por stdin/stdout. Esse fork se comunica com o main do Electron via `process.send`/`process.on('message')`.

## Componentes novos

### Arquivos
- [apps/desktop/src/main/claude/runner.ts](apps/desktop/src/main/claude/runner.ts) — orquestra spawn do `claude`, parse stream-json, fork do MCP, bridge de permissões.
- [apps/desktop/src/main/claude/permission-mcp.ts](apps/desktop/src/main/claude/permission-mcp.ts) — MCP server stdio. Bundleado separado, rodado como child Node process.
- [apps/desktop/src/main/claude/types.ts](apps/desktop/src/main/claude/types.ts) — tipos compartilhados (eventos do stream, request/response de permissão).
- [apps/desktop/src/renderer/components/ClaudePanel.tsx](apps/desktop/src/renderer/components/ClaudePanel.tsx) — painel de chat dedicado.
- [apps/desktop/src/renderer/components/PermissionModal.tsx](apps/desktop/src/renderer/components/PermissionModal.tsx) — modal Sim/Não.
- `mcp-config.json` (gerado em runtime em `app.getPath('userData')`) — aponta o `claude` pro permission-mcp.

### Modificações
- [apps/desktop/src/shared/ipc.ts](apps/desktop/src/shared/ipc.ts) — novos eventos: `claude_state`, `claude_message`, `claude_permission_request`. Novos métodos no `AssistantApi`: `claudeStart`, `claudeCancel`, `claudePermissionResponse`.
- [apps/desktop/src/preload/index.ts](apps/desktop/src/preload/index.ts) — expõe os métodos novos.
- [apps/desktop/src/main/index.ts](apps/desktop/src/main/index.ts) — wireup IPC, lifecycle do runner.
- [apps/desktop/src/renderer/App.tsx](apps/desktop/src/renderer/App.tsx) — botão Claude no header, monta painel e modal.
- `apps/desktop/electron.vite.config.*` — entrada extra pra bundlar `permission-mcp.ts` standalone (sem dependências do Electron).

### Dependências
- `@modelcontextprotocol/sdk` (runtime, no `apps/desktop`).

## Eventos IPC (contrato)

```ts
// Main → Renderer
| { type: 'claude_state'; state: 'idle' | 'starting' | 'running' | 'done' | 'error'; reason?: string }
| { type: 'claude_message'; messageId: string; role: 'assistant' | 'tool'; text: string; streaming: boolean }
| { type: 'claude_tool_use'; messageId: string; tool: string; input: unknown }
| { type: 'claude_permission_request'; requestId: string; tool: string; input: unknown; summary: string }

// Renderer → Main
claudeStart(prompt: string): Promise<{ ok: boolean; reason?: string }>
claudeCancel(): Promise<void>
claudePermissionResponse(requestId: string, allowed: boolean): void
```

## Flags do `claude`

```bash
claude -p "<prompt do usuário>" \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --mcp-config <path/to/mcp-config.json> \
  --permission-prompt-tool mcp__voice__ask_user \
  --allowedTools "Read,Glob,Grep,LS"
```

- `Read,Glob,Grep,LS` pré-liberados pra ele explorar o repo sem perguntar a cada arquivo.
- `Bash`, `Edit`, `Write`, `WebFetch` etc. caem no `ask_user` → modal.
- `cwd` do spawn = projeto alvo (fixo no MVP).

## Schema da tool `ask_user` (MCP)

```ts
{
  name: 'ask_user',
  inputSchema: {
    tool_name: string,   // ex: "Bash"
    input: object,       // ex: { command: "npm install" }
  }
}
```

Retorno (texto JSON-stringificado dentro de `content`):
- Allow: `{ "behavior": "allow", "updatedInput": <input original> }`
- Deny:  `{ "behavior": "deny",  "message": "Usuário negou" }`

## Fases

### Fase 1 — MVP texto + modal (esta entrega)
1. Instalar `@modelcontextprotocol/sdk`.
2. Criar `permission-mcp.ts` com a tool `ask_user`. Bridge IPC com main via `process.send`/`process.on('message')`. Timeout de 60s = deny.
3. Configurar electron-vite pra bundlar o permission-mcp como entry separado.
4. Criar `runner.ts`: spawn `claude`, fork do MCP, gerar `mcp-config.json` em `userData`, parse linha-a-linha do stdout (stream-json), emite eventos.
5. Adicionar handlers IPC no `main/index.ts`: `claude:start`, `claude:cancel`, `claude:permission-response`. Garantir cleanup no `window-all-closed`.
6. Estender `shared/ipc.ts` com eventos e métodos novos. Atualizar `preload/index.ts`.
7. Criar `ClaudePanel.tsx` — input + área de mensagens + botão cancelar. Botão "🤖 claude" no header pra abrir/fechar.
8. Criar `PermissionModal.tsx` — pergunta + Sim/Não + 60s countdown.
9. Smoke test: pedir "liste os arquivos da raiz e abra o package.json" → ver tool calls + texto stream.

**Critério de aceite Fase 1:**
- Digito "crie um arquivo HELLO.txt com 'oi'" no painel.
- Modal pergunta "permitir Write em HELLO.txt?".
- Clico Sim → arquivo aparece na pasta.
- Texto final "Criei HELLO.txt" aparece no painel.

### Fase 2 — Voz (TTS de saída + tool no Gemini Live)
10. Texto do Claude vai pro `TtsEngine` existente (Piper) com `SentenceBuffer`.
11. Pergunta da modal lida via TTS quando aparece.
12. Tool `claude_code_task` declarada no `tool-declarations.ts`. `executeIntegration` rota pra `runner.startClaudeTask(args.task)` e retorna texto curto pro Gemini ("ok, vou trabalhar nisso, te aviso").
13. Pausar Gemini Live (ou marcar busy) durante a execução pra não falar por cima.
14. Ao terminar, Gemini retoma e fala o resumo final.

### Fase 3 — Resposta de permissão por voz
15. Quando modal abre, ativa um listener de fala curta (Web Speech API ou STT do próprio Live).
16. Mapeia "sim/pode/manda/aceito" → allow; "não/cancela/nega" → deny.
17. Modal continua respondendo a clique como fallback.

### Fase 4 — Multi-projeto
18. Comando "trabalhar no projeto X" troca o `cwd` do próximo `startClaudeTask`.
19. Lista de projetos conhecidos em `~/.config/jarvis/projects.json` ou similar.

## O que vou pedir pra você rodar

Durante a Fase 1, em ordem:

1. **`npm install @modelcontextprotocol/sdk -w apps/desktop`** — adiciona dependência. Eu rodo, mas confirma quando der prompt de permissão.
2. **`npm run dev:desktop`** — pra testar. Eu peço quando estiver pronto.
3. Opcional: **`npm run typecheck -w apps/desktop`** — rodo eu mesmo no fim de cada bloco grande.

Você não precisa fazer nada fora isso. Se algo quebrar no app, te peço pra colar o erro.

## Riscos & decisões abertas

- **Bundle do MCP:** electron-vite por padrão bundla `main` num arquivo só. Vou precisar de uma entry adicional pra `permission-mcp.ts` rodar standalone (sem importar coisas de Electron). Se complicar muito, plano B: não bundla, roda direto o `.ts` via `tsx` em dev e copia o `.js` pro `out/` no build.
- **Caminhos do MCP em produção:** `mcp-config.json` precisa apontar pro `permission-mcp.js` no path correto em dev e em build empacotado. Resolver com `app.getAppPath()` + `app.isPackaged`.
- **Race entre múltiplas requests de permissão:** o Claude pode pedir várias em sequência rápida. Modal precisa filar (queue) ou bloquear o stdin do MCP até resolver a anterior. Vou serializar.
- **Conflito Gemini Live vs Claude Code (Fase 2+):** áudio simultâneo é ruim. Solução: pausar `live` ou apenas suprimir o `live_audio` enquanto o estado Claude for `running`.
- **Rate limit Pro/Max:** uso programático intenso pode bater limite. Sem mitigação no MVP — a gente observa.

## Próximos passos imediatos

Aguardo seu ok pra começar a Fase 1 pelo passo 1 (instalar SDK). Implemento bloco por bloco e te aviso quando precisar testar.
