import { z } from 'zod';

// Comandos que o CLIENTE Electron executa.
// Comandos internos do backend (ex: weather) não aparecem aqui — viram resposta de chat.

export const OpenAppCommandSchema = z.object({
  action: z.literal('open_app'),
  name: z.string().min(1).describe('Nome amigável do programa, ex: "spotify", "vscode", "firefox"'),
});
export type OpenAppCommand = z.infer<typeof OpenAppCommandSchema>;

export const OpenUrlCommandSchema = z.object({
  action: z.literal('open_url'),
  url: z.string().url().describe('URL completa para abrir no browser padrão'),
});
export type OpenUrlCommand = z.infer<typeof OpenUrlCommandSchema>;

export const WebSearchCommandSchema = z.object({
  action: z.literal('web_search'),
  query: z.string().min(1).describe('O que pesquisar'),
});
export type WebSearchCommand = z.infer<typeof WebSearchCommandSchema>;

export const ClientCommandSchema = z.discriminatedUnion('action', [
  OpenAppCommandSchema,
  OpenUrlCommandSchema,
  WebSearchCommandSchema,
]);
export type ClientCommand = z.infer<typeof ClientCommandSchema>;

// Comandos só-do-backend (internos): geram texto de resposta.
export const WeatherIntentSchema = z.object({
  action: z.literal('weather'),
  when: z.enum(['today', 'tomorrow']).default('today'),
});
export type WeatherIntent = z.infer<typeof WeatherIntentSchema>;

// Intent de YouTube: backend resolve pra um vídeo específico baseado no `prefer`
// e devolve como `open_url`. Cliente nunca recebe `play_youtube` direto.
export const PlayYoutubeIntentSchema = z.object({
  action: z.literal('play_youtube'),
  query: z.string().min(1),
  prefer: z.enum(['top', 'latest', 'first']).default('top'),
});
export type PlayYoutubeIntent = z.infer<typeof PlayYoutubeIntentSchema>;

// ClickUp — intents de leitura. Backend executa, vira chat (texto pro TTS).
export const ClickupTasksInProgressIntentSchema = z.object({
  action: z.literal('clickup_tasks_in_progress'),
});
export type ClickupTasksInProgressIntent = z.infer<typeof ClickupTasksInProgressIntentSchema>;

export const ClickupTasksHighPriorityIntentSchema = z.object({
  action: z.literal('clickup_tasks_high_priority'),
});
export type ClickupTasksHighPriorityIntent = z.infer<typeof ClickupTasksHighPriorityIntentSchema>;

export const ClickupExplainTaskIntentSchema = z.object({
  action: z.literal('clickup_explain_task'),
  taskId: z.string().min(1).describe('ID da task no ClickUp (ex: 868abc12) ou custom id'),
});
export type ClickupExplainTaskIntent = z.infer<typeof ClickupExplainTaskIntentSchema>;

// Union de tudo que pode sair do LLM como JSON.
export const AnyIntentSchema = z.discriminatedUnion('action', [
  OpenAppCommandSchema,
  OpenUrlCommandSchema,
  WebSearchCommandSchema,
  WeatherIntentSchema,
  PlayYoutubeIntentSchema,
  ClickupTasksInProgressIntentSchema,
  ClickupTasksHighPriorityIntentSchema,
  ClickupExplainTaskIntentSchema,
]);
export type AnyIntent = z.infer<typeof AnyIntentSchema>;

export function isClientCommand(intent: AnyIntent): intent is ClientCommand {
  return (
    intent.action === 'open_app' ||
    intent.action === 'open_url' ||
    intent.action === 'web_search'
  );
}
