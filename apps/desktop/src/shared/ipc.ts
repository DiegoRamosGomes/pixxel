import type { ClientCommand } from '@assistant/shared';

export type ConnState = 'connecting' | 'open' | 'closed' | 'error';

export type LiveState =
  | { kind: 'idle' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'connecting' }
  | { kind: 'ready' }
  | { kind: 'speaking' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'closed'; reason: string };

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
  | { type: 'assistant_error'; code: string; message: string }
  | { type: 'tts_state'; enabled: boolean; available: boolean }
  | { type: 'tts_speaking'; speaking: boolean }
  | { type: 'live_state'; state: LiveState }
  | { type: 'live_audio'; pcm: ArrayBuffer; sampleRate: number }
  | { type: 'live_transcript'; role: 'user' | 'model'; text: string };

export type AssistantApi = {
  sendText: (text: string) => Promise<void>;
  toggleTts: () => Promise<{ enabled: boolean; available: boolean }>;
  liveStart: () => Promise<{ ok: boolean; reason?: string }>;
  liveStop: () => Promise<void>;
  liveSendAudio: (pcm16k: ArrayBuffer) => void;
  liveSendText: (text: string) => Promise<{ ok: boolean; reason?: string }>;
  liveEndTurn: () => void;
  onEvent: (handler: (e: RendererEvent) => void) => () => void;
};

declare global {
  interface Window {
    assistant: AssistantApi;
  }
}
