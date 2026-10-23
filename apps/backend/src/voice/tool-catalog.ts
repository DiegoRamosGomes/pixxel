// Onde cada tool roda e quais o cliente recebe.
//
// - Tool local direta: o nome da tool é uma operação local; a API repassa a
//   chamada pro cliente. Só existe pra clientes que declararam a operação.
// - Tool mista: a API faz a parte de dados e pede ao cliente a parte local
//   (ex.: play_youtube busca o vídeo e manda o cliente abrir a URL).
// - O resto roda na API.

import type { LocalOp } from '@assistant/shared';
import type { ToolDeclaration } from './gemini-live.js';
import { ALL_TOOLS } from './tool-declarations.js';

export const DIRECT_LOCAL_TOOLS: ReadonlySet<LocalOp> = new Set<LocalOp>([
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
]);

export const MIXED_TOOL_REQUIREMENTS: Record<string, LocalOp[]> = {
  play_youtube: ['open_url'],
  look_at_camera: ['camera_frame'],
  test_desktop_control: ['desktop_mouse', 'desktop_type', 'desktop_key'],
  start_presentation: ['desktop_mouse', 'desktop_type', 'desktop_key', 'open_chat', 'open_camera', 'show_memory'],
};

export type ToolRoute =
  | { kind: 'server' }
  | { kind: 'local'; op: LocalOp }
  | { kind: 'unavailable'; reason: string };

const UNAVAILABLE: ToolRoute = { kind: 'unavailable', reason: 'Função indisponível neste dispositivo.' };

export function routeTool(name: string, localOps: readonly LocalOp[]): ToolRoute {
  if (DIRECT_LOCAL_TOOLS.has(name as LocalOp)) {
    return localOps.includes(name as LocalOp) ? { kind: 'local', op: name as LocalOp } : UNAVAILABLE;
  }
  const required = MIXED_TOOL_REQUIREMENTS[name];
  if (required && !required.every((op) => localOps.includes(op))) return UNAVAILABLE;
  return { kind: 'server' };
}

export function toolsForClient(localOps: readonly LocalOp[]): ToolDeclaration[] {
  return ALL_TOOLS.filter((t) => routeTool(t.name, localOps).kind !== 'unavailable');
}
