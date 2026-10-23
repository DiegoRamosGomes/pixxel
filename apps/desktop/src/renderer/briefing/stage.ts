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
  /** Trocas agendadas: cada uma vale quando o áudio na fila chegar nela. */
  pending: Array<{ index: number; at: number }>;
  activeSince: number;
  openedAt: number;
  sawSpeaking: boolean;
  /** Quando o áudio enfileirado acaba e a visão final pode aparecer. */
  finalAt: number | null;
  /** Visão final liberada (o áudio já terminou de tocar). */
  final: boolean;
  /** Quando o palco fecha; definido ao fim do turno. */
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

/** Teto de vida do palco, pra nunca ficar na tela pra sempre. */
export const STAGE_MAX_MS = 180_000;

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
      pending: [],
      activeSince: e.now,
      openedAt: e.now,
      sawSpeaking: false,
      finalAt: null,
      final: false,
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
      // Texto do modelo já é fala, mesmo sem o aviso de 'speaking'.
      const base = { ...s, heardRaw, sawSpeaking: true };
      const floor = Math.max(s.active, s.pending[s.pending.length - 1]?.index ?? -1);
      for (let j = s.segments.length - 1; j > floor; j--) {
        if (cueHeard(heardRaw, s.segments[j].cue)) {
          // Acrescenta; nunca sobrescreve uma troca já agendada.
          return { ...base, pending: [...s.pending, { index: j, at: e.now + e.backlogMs }] };
        }
      }
      return base;
    }
    case 'turn_end': {
      if (!s.sawSpeaking) return s;
      const finalAt = e.now + e.backlogMs;
      return { ...s, finalAt, closeAt: finalAt + STAGE_LINGER_MS };
    }
    case 'tick': {
      if (e.now - s.openedAt >= STAGE_MAX_MS) return null;
      if (s.closeAt !== null && e.now >= s.closeAt) return null;
      let next = s;
      const due = s.pending.filter((p) => e.now >= p.at);
      if (due.length > 0) {
        const index = Math.max(...due.map((p) => p.index));
        next = {
          ...next,
          active: index,
          activeSince: e.now,
          pending: s.pending.filter((p) => e.now < p.at),
        };
      } else if (
        s.pending.length === 0 &&
        s.active + 1 < s.segments.length &&
        e.now - s.activeSince >= fallbackMs(s.segments[s.active].say)
      ) {
        next = { ...next, active: s.active + 1, activeSince: e.now };
      }
      if (next.finalAt !== null && !next.final && e.now >= next.finalAt) {
        next = { ...next, final: true };
      }
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
      if (e.state.kind === 'error' || e.state.kind === 'closed' || e.state.kind === 'idle') {
        return { type: 'close' };
      }
      return null;
    case 'live_interrupted':
      return { type: 'interrupt' };
    default:
      return null;
  }
}
