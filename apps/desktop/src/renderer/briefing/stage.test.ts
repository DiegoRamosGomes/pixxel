import { describe, expect, it } from 'vitest';
import type { RendererEvent } from '../../shared/ipc.js';
import type { BriefingSegment, BriefingWidget } from '../../shared/widgets.js';
import {
  fallbackMs,
  stageReducer,
  STAGE_MAX_MS,
  STAGE_LINGER_MS,
  toStageEvent,
  type StageState,
} from './stage.js';

const seg = (say: string, cue: string): BriefingSegment =>
  ({ kind: 'date', say, cue, weekday: 'x', day: 1, monthYear: 'y' }) as BriefingSegment;

const widget: BriefingWidget = {
  kind: 'briefing',
  segments: [
    seg('Bom dia, hoje é sexta.', 'bom dia hoje'),
    seg('O tempo em Jaguaruna está firme.', 'o tempo em'),
    seg('Na economia, o dólar caiu.', 'na economia o'),
    seg('Em tecnologia, novo chip.', 'em tecnologia novo'),
    seg('Mundo.', 'no mundo paises assinam'),
  ],
};

const open = (now = 0) => stageReducer(null, { type: 'open', widget, now }) as StageState;

describe('stageReducer', () => {
  it('abre na data', () => {
    expect(open().active).toBe(0);
  });

  it('deixa respeita a fila de áudio', () => {
    let s = open();
    s = stageReducer(s, { type: 'model_text', text: 'O tempo em Jaguaruna', now: 1000, backlogMs: 800 })!;
    s = stageReducer(s, { type: 'tick', now: 1500 })!;
    expect(s.active).toBe(0);
    s = stageReducer(s, { type: 'tick', now: 1800 })!;
    expect(s.active).toBe(1);
  });

  it('pula para a frente e nunca volta', () => {
    let s: StageState = { ...open(), active: 2 };
    s = stageReducer(s, { type: 'model_text', text: 'bom dia hoje', now: 10, backlogMs: 0 })!;
    s = stageReducer(s, { type: 'tick', now: 20 })!;
    expect(s.active).toBe(2);

    s = open();
    s = stageReducer(s, { type: 'model_text', text: 'Em tecnologia, novo chip', now: 10, backlogMs: 0 })!;
    s = stageReducer(s, { type: 'tick', now: 20 })!;
    expect(s.active).toBe(3);
  });

  it('rede de segurança avança sem transcrição e para no último', () => {
    let s = open(0);
    s = stageReducer(s, { type: 'tick', now: fallbackMs(widget.segments[0].say) })!;
    expect(s.active).toBe(1);
    s = { ...s, active: 4, activeSince: 0 };
    s = stageReducer(s, { type: 'tick', now: 100000 })!;
    expect(s.active).toBe(4);
  });

  it('duas deixas na mesma janela não pulam cartão', () => {
    let s = open();
    s = stageReducer(s, { type: 'model_text', text: 'o tempo em', now: 0, backlogMs: 3000 })!;
    s = stageReducer(s, { type: 'model_text', text: ' na economia o', now: 1000, backlogMs: 6000 })!;
    s = stageReducer(s, { type: 'tick', now: 3000 })!;
    expect(s.active).toBe(1);
    s = stageReducer(s, { type: 'tick', now: 6999 })!;
    expect(s.active).toBe(1);
    s = stageReducer(s, { type: 'tick', now: 7000 })!;
    expect(s.active).toBe(2);
  });

  it('rede bloqueada com troca agendada', () => {
    let s = open();
    s = stageReducer(s, { type: 'model_text', text: 'o tempo em', now: 0, backlogMs: 50000 })!;
    s = stageReducer(s, { type: 'tick', now: 20000 })!;
    expect(s.active).toBe(0);
  });

  it('deixa partida em dois pedaços', () => {
    let s = open();
    s = stageReducer(s, { type: 'model_text', text: 'no mun', now: 0, backlogMs: 0 })!;
    s = stageReducer(s, { type: 'model_text', text: 'do paises assinam', now: 1, backlogMs: 0 })!;
    s = stageReducer(s, { type: 'tick', now: 2 })!;
    expect(s.active).toBe(4);
  });

  it('fala sem aviso de speaking arma closeAt', () => {
    let s = open();
    s = stageReducer(s, { type: 'model_text', text: 'oi', now: 0, backlogMs: 0 })!;
    s = stageReducer(s, { type: 'turn_end', now: 10, backlogMs: 0 })!;
    expect(s.closeAt).toBe(10 + STAGE_LINGER_MS);
  });

  it('visão final espera o áudio', () => {
    let s = open();
    s = stageReducer(s, { type: 'speaking' })!;
    s = stageReducer(s, { type: 'turn_end', now: 0, backlogMs: 2000 })!;
    expect(stageReducer(s, { type: 'tick', now: 1999 })!.final).toBe(false);
    expect(stageReducer(s, { type: 'tick', now: 2000 })!.final).toBe(true);
  });

  it('teto de vida', () => {
    const s = open(100);
    expect(stageReducer(s, { type: 'tick', now: 100 + STAGE_MAX_MS - 1 })).not.toBeNull();
    expect(stageReducer(s, { type: 'tick', now: 100 + STAGE_MAX_MS })).toBeNull();
  });

  it('fallbackMs fórmula', () => {
    expect(fallbackMs('x'.repeat(100))).toBe(8700);
  });

  it('fallbackMs respeita os limites', () => {
    expect(fallbackMs('a')).toBe(2500);
    expect(fallbackMs('a'.repeat(1000))).toBe(15000);
  });

  it('turn_end sem fala não agenda fechamento', () => {
    const s = stageReducer(open(), { type: 'turn_end', now: 0, backlogMs: 0 })!;
    expect(s.closeAt).toBeNull();
  });

  it('turn_end depois de falar fecha após fila + permanência', () => {
    let s = open();
    s = stageReducer(s, { type: 'speaking' })!;
    s = stageReducer(s, { type: 'turn_end', now: 0, backlogMs: 1000 })!;
    expect(s.closeAt).toBe(1000 + STAGE_LINGER_MS);
    expect(stageReducer(s, { type: 'tick', now: 6999 })).not.toBeNull();
    expect(stageReducer(s, { type: 'tick', now: 7000 })).toBeNull();
  });

  it('interrupção e close encerram; estado nulo ignora o resto', () => {
    expect(stageReducer(open(), { type: 'interrupt' })).toBeNull();
    expect(stageReducer(open(), { type: 'close' })).toBeNull();
    expect(stageReducer(null, { type: 'tick', now: 1 })).toBeNull();
    expect(stageReducer(null, { type: 'speaking' })).toBeNull();
  });
});

describe('toStageEvent', () => {
  it('fala do usuário não conta', () => {
    expect(toStageEvent({ type: 'live_transcript', role: 'user', text: 'bom dia' }, 0, 0, 'ready')).toBeNull();
  });

  it('ready só vira turn_end depois de speaking', () => {
    const ready = { type: 'live_state', state: { kind: 'ready' } } satisfies RendererEvent;
    expect(toStageEvent(ready, 5, 7, 'thinking')).toBeNull();
    expect(toStageEvent(ready, 5, 7, 'speaking')).toEqual({ type: 'turn_end', now: 5, backlogMs: 7 });
  });

  it('sessão caiu fecha o palco', () => {
    const closed = { type: 'live_state', state: { kind: 'closed', reason: 'x' } } satisfies RendererEvent;
    expect(toStageEvent(closed, 0, 0, 'speaking')).toEqual({ type: 'close' });
    const idle = { type: 'live_state', state: { kind: 'idle' } } satisfies RendererEvent;
    expect(toStageEvent(idle, 0, 0, '')).toEqual({ type: 'close' });
  });

  it('mapeia widget briefing, texto do modelo, speaking e interrupção', () => {
    expect(toStageEvent({ type: 'widget', id: 'a', widget, ttlMs: 1 }, 3, 0, '')).toEqual({
      type: 'open',
      widget,
      now: 3,
    });
    expect(
      toStageEvent({ type: 'widget', id: 'a', widget: { kind: 'notifications', source: 'clickup', items: [] }, ttlMs: 1 }, 3, 0, ''),
    ).toBeNull();
    expect(toStageEvent({ type: 'live_transcript', role: 'model', text: 'oi' }, 3, 9, '')).toEqual({
      type: 'model_text',
      text: 'oi',
      now: 3,
      backlogMs: 9,
    });
    expect(toStageEvent({ type: 'live_state', state: { kind: 'speaking' } } satisfies RendererEvent, 0, 0, '')).toEqual({
      type: 'speaking',
    });
    expect(toStageEvent({ type: 'live_interrupted' }, 0, 0, '')).toEqual({ type: 'interrupt' });
  });
});
