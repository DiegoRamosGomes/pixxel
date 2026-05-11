export type SessionStatus =
  | 'running'
  | 'done'
  | 'paused'
  | 'crashed'
  | 'failed'
  | 'awaiting_approval'
  | 'awaiting_user_input';

export interface PendingQuestion {
  questionId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
}

/**
 * Pedido de permissão roteado pelo Claude CLI via `--permission-prompt-tool`.
 * Aguarda decisão do usuário (allow/deny) antes do Claude executar a tool.
 */
export interface PendingPermission {
  permissionId: string;
  /** Tool que o Claude quer executar (ex: 'Bash', 'Edit', 'Write'). */
  toolName: string;
  /** Args completos da tool — descrevem o que vai acontecer. */
  toolInput: Record<string, unknown>;
  /** ID interno da invocação da tool, devolvido pro CLI na resposta. */
  toolUseId: string;
}

export interface ClaudeSession {
  sessionId: string;
  cwd: string;
  project: string | null;
  taskDescription: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  pid: number | null;
  permissionMode: 'acceptEdits' | 'bypassPermissions' | 'plan';
  /** Score 1-10 atribuído pelo Gemini ao chamar claude_code_task. */
  complexity?: number;
  /** Plano gerado em modo plan, esperando aprovação. */
  pendingPlan?: string;
  /** Pergunta atual aguardando resposta (status === 'awaiting_user_input'). */
  pendingQuestion?: PendingQuestion;
  /** Pedido de permissão (Bash/Edit/Write) aguardando decisão. */
  pendingPermission?: PendingPermission;
}

export interface ClaudeOutputChunk {
  sessionId: string;
  kind: 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'error';
  text: string;
  tool?: string;
  toolInput?: unknown;
}

export interface ClaudeRunResult {
  ok: boolean;
  text?: string;
  stopReason?: string;
  error?: string;
}
