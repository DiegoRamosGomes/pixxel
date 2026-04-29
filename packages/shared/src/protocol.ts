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

export const ClientEventSchema = z.discriminatedUnion('type', [
  ClientHelloSchema,
  UserMessageSchema,
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

export const ServerEventSchema = z.discriminatedUnion('type', [
  ServerHelloOkSchema,
  AssistantStartSchema,
  AssistantChunkSchema,
  AssistantDoneSchema,
  AssistantCommandSchema,
  ServerErrorSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
