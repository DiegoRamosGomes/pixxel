import { z } from 'zod';
import { ClientCommandSchema } from './commands.js';

export const MessageSourceSchema = z.enum(['voice', 'text']);
export type MessageSource = z.infer<typeof MessageSourceSchema>;

export const ClientHelloSchema = z.object({
  type: z.literal('hello'),
  token: z.string().min(1),
  sessionId: z.string().min(1),
});
export type ClientHello = z.infer<typeof ClientHelloSchema>;

export const UserMessageSchema = z.object({
  type: z.literal('user_message'),
  sessionId: z.string().min(1),
  text: z.string().min(1),
  source: MessageSourceSchema,
});
export type UserMessage = z.infer<typeof UserMessageSchema>;

export const WebhookAckSchema = z.object({
  type: z.literal('webhook_ack'),
  eventId: z.string().min(1),
});
export type WebhookAck = z.infer<typeof WebhookAckSchema>;

export const ClientEventSchema = z.discriminatedUnion('type', [
  ClientHelloSchema,
  UserMessageSchema,
  WebhookAckSchema,
]);
export type ClientEvent = z.infer<typeof ClientEventSchema>;

export const ServerHelloOkSchema = z.object({
  type: z.literal('hello_ok'),
  sessionId: z.string(),
});
export type ServerHelloOk = z.infer<typeof ServerHelloOkSchema>;

export const AssistantStartSchema = z.object({
  type: z.literal('assistant_start'),
  messageId: z.string(),
  model: z.string(),
});
export type AssistantStart = z.infer<typeof AssistantStartSchema>;

export const AssistantChunkSchema = z.object({
  type: z.literal('assistant_chunk'),
  messageId: z.string(),
  delta: z.string(),
});
export type AssistantChunk = z.infer<typeof AssistantChunkSchema>;

export const AssistantDoneSchema = z.object({
  type: z.literal('assistant_done'),
  messageId: z.string(),
  fullText: z.string(),
});
export type AssistantDone = z.infer<typeof AssistantDoneSchema>;

export const AssistantCommandSchema = z.object({
  type: z.literal('assistant_command'),
  messageId: z.string(),
  command: ClientCommandSchema,
  spokenLabel: z.string().describe('Frase curta pra mostrar/falar enquanto a ação roda'),
  source: z.enum(['regex', 'llm']),
});
export type AssistantCommand = z.infer<typeof AssistantCommandSchema>;

export const ServerErrorSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});
export type ServerError = z.infer<typeof ServerErrorSchema>;

// Webhook que chegou no backend e tá sendo entregue pro desktop. O cliente
// deve responder com `webhook_ack` pra marcar como entregue (sem ack, o
// backend re-envia na próxima reconexão).
export const WebhookEventSchema = z.object({
  type: z.literal('webhook_event'),
  eventId: z.string(),
  provider: z.string(), // 'expo', 'github', etc.
  eventKind: z.string(), // 'build.started', 'build.finished', etc.
  receivedAt: z.number(),
  data: z.record(z.string(), z.unknown()), // payload normalizado pro renderer
});
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;

export const ServerEventSchema = z.discriminatedUnion('type', [
  ServerHelloOkSchema,
  AssistantStartSchema,
  AssistantChunkSchema,
  AssistantDoneSchema,
  AssistantCommandSchema,
  ServerErrorSchema,
  WebhookEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
