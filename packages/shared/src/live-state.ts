// Estado da sessão de voz (Gemini Live), como o cliente mostra no orb.
export type LiveState =
  | { kind: 'idle' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'connecting' }
  | { kind: 'ready' }
  | { kind: 'speaking' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'closed'; reason: string };
