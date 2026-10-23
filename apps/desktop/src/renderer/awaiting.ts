// "Pensando" do orb depois de mandar texto no chat. Liga no envio (App.send)
// e desliga quando a resposta começa, quando o turno do Gemini fecha (mesmo
// vazio) ou quando a voz cai — senão o orb fica pensando pra sempre.

import type { RendererEvent } from '../shared/ipc.js';

export function nextAwaiting(awaiting: boolean, event: RendererEvent): boolean {
  if (!awaiting) return false;
  if (event.type === 'live_transcript') return event.role !== 'model';
  if (event.type === 'live_state') return event.state.kind === 'connecting';
  return true;
}
