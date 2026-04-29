import type { ClientCommand } from '@assistant/shared';

export type ConnState = 'connecting' | 'open' | 'closed' | 'error';

export type RendererEvent =
  | { type: 'conn'; state: ConnState; reason?: string }
  | { type: 'assistant_start'; messageId: string; model: string }
  | { type: 'assistant_chunk'; messageId: string; delta: string }
  | { type: 'assistant_done'; messageId: string; fullText: string }
  | {
      type: 'assistant_command';
      messageId: string;
      command: ClientCommand;
      spokenLabel: string;
      source: 'regex' | 'llm';
      executed: { ok: boolean; reason?: string };
    }
  | { type: 'assistant_error'; code: string; message: string };

export type AssistantApi = {
  sendText: (text: string) => Promise<void>;
  onEvent: (handler: (e: RendererEvent) => void) => () => void;
};

declare global {
  interface Window {
    assistant: AssistantApi;
  }
}
