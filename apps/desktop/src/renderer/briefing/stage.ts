// Lógica do palco do briefing: qual cartão está na tela, sincronizado com a fala.
// Reducer puro: o tempo sempre vem nos eventos, nunca de Date.now().

import { cueHeard } from '@assistant/shared/briefing-cues';
import type { RendererEvent } from '../../shared/ipc.js';
import type { BriefingSegment, BriefingWidget } from '../../shared/widgets.js';

export type StageState = {
  segments: BriefingSegment[];
  active: number;
  /** Tudo que o modelo já falou (transcrição bruta acumulada). */
  heardRaw: string;
  /** Troca agendada: vale quando o áudio na fila terminar de tocar. */
  pending: { index: number; at: number } | null;
  activeSince: number;
  sawSpeaking: boolean;
  /** Quando o palco fecha; definido ao fim do turno (visão final). */
  closeAt: number | null;
};

export type StageEvent =
  | { type: 'open'; widget: BriefingWidget; now: number }
  | { type: 'model_text'; text: string; now: number; backlogMs: number }
  | { type: 'speaking' }
  | { type: 'turn_end'; now: number; backlogMs: number }
  | { type: 'tick'; now: number }
  | { type: 'interrupt' }
  | { type: 'close' };

/** Quanto o palco fica na tela depois que a fala acaba. */
export const STAGE_LINGER_MS = 6000;

/** Tempo máximo num cartão se a transcrição não confirmar a deixa. */
export function fallbackMs(say: string): number {
  return Math.min(15000, Math.max(2500, say.length * 75 + 1200));
}

export function stageReducer(s: StageState | null, e: StageEvent): StageState | null {
  if (e.type === 'open') {
    return {
      segments: e.widget.segments,
      active: 0,
      heardRaw: '',
      pending: null,
      activeSince: e.now,
      sawSpeaking: false,
      closeAt: null,
    };
  }
  if (!s) return null;

  switch (e.type) {
    case 'interrupt':
    case 'close':
      return null;
    case 'speaking':
      return { ...s, sawSpeaking: true };
    case 'model_text': {
      const heardRaw = s.heardRaw + e.text;
      const floor = Math.max(s.active, s.pending?.index ?? -1);
      let hit = -1;
      for (let j = s.segments.length - 1; j > floor; j--) {
        if (cueHeard(heardRaw, s.segments[j].cue)) {
          hit = j;
          break;
        }
      }
      if (hit < 0) return { ...s, heardRaw };
      return { ...s, heardRaw, pending: { index: hit, at: e.now + e.backlogMs } };
    }
    case 'turn_end':
      if (!s.sawSpeaking) return s;
      return { ...s, closeAt: e.now + e.backlogMs + STAGE_LINGER_MS };
    case 'tick': {
      let next = s;
      if (s.pending && e.now >= s.pending.at) {
        next = { ...s, active: s.pending.index, pending: null, activeSince: e.now };
      } else if (
        !s.pending &&
        s.active + 1 < s.segments.length &&
        e.now - s.activeSince >= fallbackMs(s.segments[s.active].say)
      ) {
        next = { ...s, active: s.active + 1, activeSince: e.now };
      }
      if (next.closeAt !== null && e.now >= next.closeAt) return null;
      return next;
    }
  }
}

/** Traduz um evento do main para o do palco; null quando não interessa. */
export function toStageEvent(
  e: RendererEvent,
  now: number,
  backlogMs: number,
  prevLiveKind: string,
): StageEvent | null {
  switch (e.type) {
    case 'widget':
      return e.widget.kind === 'briefing' ? { type: 'open', widget: e.widget, now } : null;
    case 'live_transcript':
      return e.role === 'model' ? { type: 'model_text', text: e.text, now, backlogMs } : null;
    case 'live_state':
      if (e.state.kind === 'speaking') return { type: 'speaking' };
      if (e.state.kind === 'ready' && prevLiveKind === 'speaking') {
        return { type: 'turn_end', now, backlogMs };
      }
      return null;
    case 'live_interrupted':
      return { type: 'interrupt' };
    default:
      return null;
  }
}
