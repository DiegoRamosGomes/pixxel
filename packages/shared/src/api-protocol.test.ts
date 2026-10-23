import { describe, expect, it } from 'vitest';
import { ApiClientMessageSchema, ApiServerMessageSchema } from './api-protocol.js';

describe('protocolo cliente → API', () => {
  it('aceita hello válido', () => {
    const m = {
      type: 'hello',
      protocolVersion: 2,
      token: 't'.repeat(8),
      clientId: 'desktop-mac',
      clientKind: 'desktop',
      localOps: ['open_app', 'device_status'],
    };
    expect(ApiClientMessageSchema.parse(m)).toEqual(m);
  });

  it('rejeita operação local desconhecida no hello', () => {
    const m = { type: 'hello', protocolVersion: 2, token: 'x', clientId: 'a', clientKind: 'desktop', localOps: ['format_disk'] };
    expect(ApiClientMessageSchema.safeParse(m).success).toBe(false);
  });

  it('rejeita voice_text vazio', () => {
    expect(ApiClientMessageSchema.safeParse({ type: 'voice_text', text: '' }).success).toBe(false);
  });

  it('local_tool_result exige reason quando ok=false', () => {
    const m = { type: 'local_tool_result', callId: 'c1', result: { ok: false } };
    expect(ApiClientMessageSchema.safeParse(m).success).toBe(false);
  });
});

describe('protocolo API → cliente', () => {
  it('widget exige kind', () => {
    expect(ApiServerMessageSchema.safeParse({ type: 'widget', id: 'w', widget: {}, ttlMs: 1 }).success).toBe(false);
    expect(
      ApiServerMessageSchema.safeParse({ type: 'widget', id: 'w', widget: { kind: 'weather' }, ttlMs: 1 }).success,
    ).toBe(true);
  });

  it('local_tool_call só com operação conhecida', () => {
    expect(
      ApiServerMessageSchema.safeParse({ type: 'local_tool_call', callId: 'c', name: 'camera_frame', args: {} }).success,
    ).toBe(true);
    expect(
      ApiServerMessageSchema.safeParse({ type: 'local_tool_call', callId: 'c', name: 'rm_rf', args: {} }).success,
    ).toBe(false);
  });
});

describe('estado da apresentação', () => {
  it('API avisa o cliente quando a apresentação começa e termina', () => {
    expect(ApiServerMessageSchema.safeParse({ type: 'presentation_state', running: true }).success).toBe(true);
    expect(ApiServerMessageSchema.safeParse({ type: 'presentation_state' }).success).toBe(false);
  });

  it('API avisa o cliente quando a fala do modelo é interrompida', () => {
    expect(() => ApiServerMessageSchema.parse({ type: 'voice_interrupted' })).not.toThrow();
  });
});
