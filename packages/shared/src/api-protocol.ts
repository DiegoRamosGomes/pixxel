// Protocolo v2 entre clientes (desktop, celular) e a API.
//
// Mensagens de controle vão como JSON em frames de texto do WebSocket. Áudio
// vai em frames BINÁRIOS, sem envelope:
//   cliente → API: PCM16LE mono 16 kHz (microfone)
//   API → cliente: PCM16LE mono 24 kHz (fala do Gemini)

import { z } from 'zod';
import type { LiveState } from './live-state.js';
import type { Widget } from './widgets.js';

export const PROTOCOL_VERSION = 2;
export const MIC_SAMPLE_RATE = 16000;
export const SPEAKER_SAMPLE_RATE = 24000;

/** Operações que só o cliente sabe fazer, porque mexem na máquina dele. */
export const LOCAL_OPS = [
  'open_app',
  'open_url',
  'media_control',
  'open_project',
  'desktop_mouse',
  'desktop_type',
  'desktop_key',
  'restart_wifi',
  'restart_app',
  'open_chat',
  'show_memory',
  'open_camera',
  'camera_frame',
  'device_status',
  'device_storage',
] as const;
export type LocalOp = (typeof LOCAL_OPS)[number];
export const LocalOpSchema = z.enum(LOCAL_OPS);

export const ClientKindSchema = z.enum(['desktop', 'mobile']);
export type ClientKind = z.infer<typeof ClientKindSchema>;

export const LocalToolResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    text: z.string().optional(),
    meta: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
export type LocalToolResult = z.infer<typeof LocalToolResultSchema>;

// ===== Cliente → API =====

export const ApiClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello'),
    protocolVersion: z.number().int(),
    token: z.string().min(1),
    clientId: z.string().min(1),
    clientKind: ClientKindSchema,
    localOps: z.array(LocalOpSchema),
  }),
  z.object({ type: z.literal('voice_start') }),
  z.object({ type: z.literal('voice_stop') }),
  z.object({ type: z.literal('voice_text'), text: z.string().min(1) }),
  z.object({ type: z.literal('voice_end_turn') }),
  z.object({
    type: z.literal('local_tool_result'),
    callId: z.string().min(1),
    result: LocalToolResultSchema,
  }),
  z.object({ type: z.literal('explain_clickup_task'), taskId: z.string().min(1) }),
  z.object({ type: z.literal('presentation_abort') }),
]);
export type ApiClientMessage = z.infer<typeof ApiClientMessageSchema>;

// ===== API → cliente =====

const LiveStateSchema = z.custom<LiveState>(
  (v) => typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string',
);
const WidgetSchema = z.custom<Widget>(
  (v) => typeof v === 'object' && v !== null && typeof (v as { kind?: unknown }).kind === 'string',
);

export const ApiServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello_ok'), clientId: z.string() }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }),
  z.object({ type: z.literal('voice_state'), state: LiveStateSchema }),
  z.object({ type: z.literal('transcript'), role: z.enum(['user', 'model']), text: z.string() }),
  z.object({ type: z.literal('widget'), id: z.string(), widget: WidgetSchema, ttlMs: z.number() }),
  z.object({ type: z.literal('widget_dismiss'), id: z.string() }),
  z.object({
    type: z.literal('local_tool_call'),
    callId: z.string(),
    name: LocalOpSchema,
    args: z.record(z.string(), z.unknown()),
  }),
]);
export type ApiServerMessage = z.infer<typeof ApiServerMessageSchema>;
