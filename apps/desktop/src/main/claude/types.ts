export type SessionStatus = 'running' | 'done' | 'paused' | 'crashed' | 'failed';

export interface ClaudeSession {
  sessionId: string;
  cwd: string;
  project: string | null;
  taskDescription: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  pid: number | null;
  permissionMode: 'acceptEdits' | 'bypassPermissions';
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
