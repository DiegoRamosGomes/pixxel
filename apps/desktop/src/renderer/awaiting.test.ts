import { describe, expect, it } from 'vitest';
import { nextAwaiting } from './awaiting.js';

describe('"pensando" depois de mandar texto no chat', () => {
  it('desliga quando o modelo começa a responder', () => {
    expect(nextAwaiting(true, { type: 'live_state', state: { kind: 'speaking' } })).toBe(false);
    expect(nextAwaiting(true, { type: 'live_transcript', role: 'model', text: 'Em Jaguaruna' })).toBe(false);
  });

  it('desliga quando o turno termina sem resposta (turno vazio do Gemini)', () => {
    expect(nextAwaiting(true, { type: 'live_state', state: { kind: 'ready' } })).toBe(false);
  });

  it('desliga quando a voz cai ou dá erro', () => {
    expect(nextAwaiting(true, { type: 'live_state', state: { kind: 'error', code: 'x', message: 'y' } })).toBe(false);
    expect(nextAwaiting(true, { type: 'live_state', state: { kind: 'closed', reason: 'z' } })).toBe(false);
    expect(nextAwaiting(true, { type: 'live_state', state: { kind: 'idle' } })).toBe(false);
  });

  it('continua pensando enquanto conecta ou com a transcrição do próprio usuário', () => {
    expect(nextAwaiting(true, { type: 'live_state', state: { kind: 'connecting' } })).toBe(true);
    expect(nextAwaiting(true, { type: 'live_transcript', role: 'user', text: 'oi' })).toBe(true);
    expect(nextAwaiting(true, { type: 'widget_dismiss', id: 'w' })).toBe(true);
  });

  it('não liga sozinho', () => {
    expect(nextAwaiting(false, { type: 'live_state', state: { kind: 'connecting' } })).toBe(false);
  });
});
