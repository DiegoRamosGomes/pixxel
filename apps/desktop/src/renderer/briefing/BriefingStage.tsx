// Palco do briefing: enquanto o Pixxel fala, o assunto da vez fica em destaque
// no centro, com a frase como legenda, e o que já foi dito vira miniatura na
// fileira de baixo. O estado vem pronto do stageReducer (stage.ts); aqui é só
// a tela e as transições.

import { useEffect, useState, type CSSProperties } from 'react';
import type { BriefingSegment } from '../../shared/widgets.js';
import type { StageState } from './stage.js';
import { DateCard, NewsCard, StageTile, WeatherStageCard } from './StageCards.js';

/** Quanto o card que sai leva pra encolher até a fileira (casa com o CSS). */
const LEAVE_MS = 350;

type Props = {
  state: StageState;
  onClose: () => void;
  onOpenNews: (url: string) => void;
};

function renderCard(segment: BriefingSegment) {
  switch (segment.kind) {
    case 'date':
      return <DateCard segment={segment} />;
    case 'weather':
      return <WeatherStageCard segment={segment} />;
    case 'news':
      return <NewsCard segment={segment} />;
  }
}

/** Desloca o card que sai pra coluna da miniatura dele na fileira. */
function leaveStyle(index: number, cols: number): CSSProperties {
  const x = ((index + 0.5) / cols - 0.5) * 100;
  return { '--to-x': `${x}%` } as CSSProperties;
}

export function BriefingStage({ state, onClose, onOpenNews }: Props) {
  const { segments } = state;
  // Na visão final não há card no centro: o orb volta e a fileira fica completa.
  const shown = state.final ? null : state.active;

  // O card que sai continua no DOM mais um pouco, com a classe de saída, pra
  // encolher em direção à fileira. Ajustado durante o render (e não num efeito)
  // pra o mesmo nó seguir montado e a transição partir de onde ele está.
  const [prevShown, setPrevShown] = useState(shown);
  const [leaving, setLeaving] = useState<number | null>(null);
  if (shown !== prevShown) {
    setPrevShown(shown);
    setLeaving(prevShown);
  }
  useEffect(() => {
    if (leaving === null) return;
    const t = window.setTimeout(() => setLeaving(null), LEAVE_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  const cols = Math.max(1, segments.length);
  const current = shown !== null ? segments[shown] : undefined;
  const cards = [leaving, shown].filter(
    (i, k, all): i is number => i !== null && segments[i] !== undefined && all.indexOf(i) === k,
  );
  const tiles = segments.slice(0, state.final ? segments.length : state.active);

  return (
    <section className={`stage${state.final ? ' stage--final' : ''}`} aria-label="briefing">
      <div className="stage__top">
        {!state.final && (
          <span className="widget__kind stage__chip">
            <span className="stage__dot" aria-hidden />
            falando
          </span>
        )}
        <button
          type="button"
          className="stage__close"
          aria-label="fechar briefing"
          title="Fechar briefing"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {current && (
        <p key={shown} className="stage__caption">
          “{current.say}”
        </p>
      )}

      <div className="stage__center">
        {cards.map((i) => (
          <div
            key={i}
            className={`stage__card stage__card--${segments[i].kind}${i === leaving ? ' stage__card--leaving' : ''}`}
            style={i === leaving ? leaveStyle(i, cols) : undefined}
            aria-hidden={i === leaving || undefined}
          >
            {renderCard(segments[i])}
          </div>
        ))}
      </div>

      <div className="stage__row">
        <span className={`stage__row-label${tiles.length === 0 ? ' stage__row-label--empty' : ''}`}>
          já falado
        </span>
        <div className="stage__tiles" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
          {tiles.map((s, i) => (
            <StageTile key={i} segment={s} onOpen={onOpenNews} />
          ))}
        </div>
      </div>
    </section>
  );
}
