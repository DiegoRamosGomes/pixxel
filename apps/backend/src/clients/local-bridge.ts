// Chamadas da API pro cliente executar uma operação local (abrir app, mexer
// no mouse, tirar foto da câmera...). Cada chamada leva um callId; o cliente
// responde com local_tool_result. A promise NUNCA rejeita: timeout, queda e
// falha de envio viram { ok: false, reason } — é isso que o Gemini recebe.

import { randomUUID } from 'node:crypto';
import type { ApiServerMessage, LocalOp, LocalToolResult } from '@assistant/shared';

type LocalToolCallMsg = Extract<ApiServerMessage, { type: 'local_tool_call' }>;

const DISCONNECTED = 'O dispositivo desconectou.';

export class LocalBridge {
  private readonly pending = new Map<
    string,
    { resolve: (r: LocalToolResult) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly send: (msg: LocalToolCallMsg) => void,
    private readonly timeoutMs: number,
  ) {}

  call(op: LocalOp, args: Record<string, unknown>): Promise<LocalToolResult> {
    const callId = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.settle(callId, { ok: false, reason: 'O dispositivo não respondeu a tempo.' });
      }, this.timeoutMs);
      this.pending.set(callId, { resolve, timer });
      try {
        this.send({ type: 'local_tool_call', callId, name: op, args });
      } catch {
        this.settle(callId, { ok: false, reason: DISCONNECTED });
      }
    });
  }

  resolve(callId: string, result: LocalToolResult): void {
    this.settle(callId, result);
  }

  rejectAll(reason: string): void {
    for (const callId of [...this.pending.keys()]) {
      this.settle(callId, { ok: false, reason });
    }
  }

  private settle(callId: string, result: LocalToolResult): void {
    const entry = this.pending.get(callId);
    if (!entry) return;
    this.pending.delete(callId);
    clearTimeout(entry.timer);
    entry.resolve(result);
  }
}
