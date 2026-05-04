import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { ServerEventSchema, type ClientEvent } from '@assistant/shared';
import type { RendererEvent } from '../shared/ipc.js';
import { executeCommand } from './executor.js';

type Emit = (event: RendererEvent) => void;

export type WsHooks = {
  /** Chamado a cada `assistant_chunk` antes de emitir pro renderer. */
  onAssistantTextChunk?: (delta: string) => void;
  /** Chamado quando `assistant_done` chega (fim do stream). */
  onAssistantTextEnd?: () => void;
  /** Chamado pra cada comando recebido — útil pra falar o spokenLabel. */
  onAssistantCommandLabel?: (label: string) => void;
};

export class AssistantWsClient {
  private ws: WebSocket | null = null;
  private readonly sessionId: string;
  private authed = false;
  private closedByUser = false;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly emit: Emit,
    private readonly hooks: WsHooks = {},
    sessionId?: string,
  ) {
    this.sessionId = sessionId ?? randomUUID();
  }

  connect(): void {
    this.closedByUser = false;
    this.emit({ type: 'conn', state: 'connecting' });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.authed = false;

    ws.on('open', () => {
      const hello: ClientEvent = {
        type: 'hello',
        token: this.token,
        sessionId: this.sessionId,
      };
      ws.send(JSON.stringify(hello));
    });

    ws.on('message', async (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const result = ServerEventSchema.safeParse(parsed);
      if (!result.success) return;
      const event = result.data;

      switch (event.type) {
        case 'hello_ok':
          this.authed = true;
          this.emit({ type: 'conn', state: 'open' });
          break;
        case 'assistant_start':
          this.emit({
            type: 'assistant_start',
            messageId: event.messageId,
            model: event.model,
          });
          break;
        case 'assistant_chunk':
          this.hooks.onAssistantTextChunk?.(event.delta);
          this.emit({
            type: 'assistant_chunk',
            messageId: event.messageId,
            delta: event.delta,
          });
          break;
        case 'assistant_done':
          this.hooks.onAssistantTextEnd?.();
          this.emit({
            type: 'assistant_done',
            messageId: event.messageId,
            fullText: event.fullText,
          });
          break;
        case 'error':
          this.emit({
            type: 'assistant_error',
            code: event.code,
            message: event.message,
          });
          break;
        case 'assistant_command': {
          this.hooks.onAssistantCommandLabel?.(event.spokenLabel);
          const exec = await executeCommand(event.command);
          this.emit({
            type: 'assistant_command',
            messageId: event.messageId,
            command: event.command,
            spokenLabel: event.spokenLabel,
            source: event.source,
            executed: exec,
          });
          break;
        }
      }
    });

    ws.on('close', (code, reason) => {
      this.authed = false;
      this.ws = null;
      this.emit({ type: 'conn', state: 'closed', reason: reason.toString() || `code ${code}` });
    });

    ws.on('error', (err) => {
      this.emit({ type: 'conn', state: 'error', reason: err.message });
    });
  }

  sendText(text: string): void {
    if (!this.ws || !this.authed) {
      this.emit({
        type: 'assistant_error',
        code: 'not_connected',
        message: 'aguardando conexão com backend',
      });
      return;
    }
    const event: ClientEvent = {
      type: 'user_message',
      sessionId: this.sessionId,
      text,
      source: 'text',
    };
    this.ws.send(JSON.stringify(event));
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }
}
