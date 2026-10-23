// Cards do palco do briefing: o assunto da vez em destaque no centro e as
// miniaturas da fileira "já falado". Só apresentação — quem decide o que
// aparece e quando é o stageReducer (stage.ts).

import { useState } from 'react';
import type { BriefingSegment } from '../../shared/widgets.js';

type DateSegment = Extract<BriefingSegment, { kind: 'date' }>;
type WeatherSegment = Extract<BriefingSegment, { kind: 'weather' }>;
type NewsSegment = Extract<BriefingSegment, { kind: 'news' }>;

// Mesmo mapa WMO → emoji do WeatherCard (cobre os códigos mais comuns).
const WMO_ICON: Record<number, string> = {
  0: '☀️',
  1: '🌤️',
  2: '⛅',
  3: '☁️',
  45: '🌫️',
  48: '🌫️',
  51: '🌦️',
  53: '🌦️',
  55: '🌧️',
  61: '🌧️',
  63: '🌧️',
  65: '🌧️',
  71: '🌨️',
  73: '🌨️',
  75: '❄️',
  80: '🌦️',
  81: '🌧️',
  82: '⛈️',
  95: '⛈️',
  96: '⛈️',
  99: '⛈️',
};

/** Só https vira <img>; qualquer outra coisa fica sem foto. */
function photoUrl(url: string | undefined): string | null {
  return url && url.startsWith('https://') ? url : null;
}

/** "há 2 h" desde a publicação; abaixo de uma hora, "há 15 min". */
function ago(publishedAt: string, now: number): string | null {
  const t = Date.parse(publishedAt);
  if (Number.isNaN(t)) return null;
  const min = Math.floor((now - t) / 60_000);
  if (min < 60) return `há ${Math.max(1, min)} min`;
  return `há ${Math.floor(min / 60)} h`;
}

function deg(c: number | undefined): string {
  return c != null ? `${Math.round(c)}°` : '—';
}

/** "outubro de 2026" → "out". */
function shortMonth(monthYear: string): string {
  return monthYear.split(' ')[0].slice(0, 3);
}

function Photo({ src, onError }: { src: string; onError: () => void }) {
  return (
    <img
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      decoding="async"
      draggable={false}
      onError={onError}
    />
  );
}

export function DateCard({ segment }: { segment: DateSegment }) {
  const obs = segment.observance;
  return (
    <div className="widget stage-card stage-date">
      <div className="widget__head">
        <span className="widget__kind">hoje</span>
        <span className="stage-card__meta">{segment.weekday}</span>
      </div>
      <div className="stage-date__body">
        <div className="stage-date__day">{segment.day}</div>
        <div className="stage-date__month">{segment.monthYear}</div>
        {obs && (
          <span className={`stage-badge stage-badge--${obs.type}`}>
            {obs.type === 'holiday' ? `Feriado · ${obs.name}` : obs.name}
          </span>
        )}
      </div>
    </div>
  );
}

export function WeatherStageCard({ segment }: { segment: WeatherSegment }) {
  const icon = (segment.weatherCode != null && WMO_ICON[segment.weatherCode]) || '🌡️';
  return (
    <div className="widget stage-card stage-weather">
      <div className="widget__head">
        <span className="widget__kind">clima · agora</span>
        <span className="stage-card__meta">{segment.place}</span>
      </div>
      <div className="stage-weather__body">
        <div>
          <div className="stage-weather__temp">{deg(segment.tempC)}</div>
          <div className="stage-weather__cond">
            <span aria-hidden>{icon}</span>
            {segment.condition}
          </div>
        </div>
        {/* Chuva aparece sempre, inclusive 0%. */}
        <dl className="stage-weather__list">
          <div>
            <dt>mín</dt>
            <dd>{deg(segment.minC)}</dd>
          </div>
          <div>
            <dt>máx</dt>
            <dd>{deg(segment.maxC)}</dd>
          </div>
          <div>
            <dt>chuva</dt>
            <dd>{segment.rainPercent != null ? `${Math.round(segment.rainPercent)}%` : '—'}</dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

export function NewsCard({ segment }: { segment: NewsSegment }) {
  // Foto que falha some e o texto ocupa o card inteiro.
  const [photoFailed, setPhotoFailed] = useState(false);
  const photo = photoFailed ? null : photoUrl(segment.imageUrl);
  const when = ago(segment.publishedAt, Date.now());
  return (
    <div className="widget stage-card stage-news">
      {photo && (
        <div className="stage-news__photo">
          <Photo src={photo} onError={() => setPhotoFailed(true)} />
        </div>
      )}
      <div className="stage-news__text">
        <span className="widget__kind">{segment.area}</span>
        <h2 className="stage-news__title">{segment.title}</h2>
        {segment.summary && <p className="stage-news__summary">{segment.summary}</p>}
        <span className="stage-card__meta stage-news__meta">
          {when ? `${segment.source} · ${when}` : segment.source}
        </span>
      </div>
    </div>
  );
}

function NewsTile({ segment, onOpen }: { segment: NewsSegment; onOpen?: (url: string) => void }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const photo = photoFailed ? null : photoUrl(segment.imageUrl);
  return (
    <button
      type="button"
      className="stage-tile stage-tile--news"
      title={segment.title}
      aria-label={`abrir matéria: ${segment.title}`}
      disabled={!onOpen}
      onClick={() => onOpen?.(segment.url)}
    >
      <span className="stage-tile__label">{segment.area}</span>
      <span className="stage-tile__thumb">
        {photo && <Photo src={photo} onError={() => setPhotoFailed(true)} />}
      </span>
    </button>
  );
}

export function StageTile({
  segment,
  onOpen,
}: {
  segment: BriefingSegment;
  onOpen?: (url: string) => void;
}) {
  switch (segment.kind) {
    case 'date':
      return (
        <div className="stage-tile">
          <span className="stage-tile__label">hoje</span>
          <span className="stage-tile__value">
            {segment.day} {shortMonth(segment.monthYear)}
          </span>
        </div>
      );
    case 'weather':
      return (
        <div className="stage-tile">
          <span className="stage-tile__label">clima</span>
          <span className="stage-tile__value">{deg(segment.tempC)}</span>
        </div>
      );
    case 'news':
      return <NewsTile segment={segment} onOpen={onOpen} />;
  }
}
