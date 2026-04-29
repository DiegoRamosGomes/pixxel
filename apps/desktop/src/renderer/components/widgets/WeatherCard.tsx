import type { WeatherWidget } from '../../../shared/widgets.js';

// Mapping WMO → emoji simples (cobre os códigos mais comuns)
const ICON: Record<number, string> = {
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

export function WeatherCard({ data }: { data: WeatherWidget }) {
  const icon = (data.weatherCode != null && ICON[data.weatherCode]) || '🌡️';
  const whenLabel = data.when === 'today' ? 'agora' : 'amanhã';
  const tempStr =
    data.tempC != null
      ? `${Math.round(data.tempC)}°`
      : data.maxC != null
        ? `${Math.round(data.maxC)}°`
        : '—';
  return (
    <div className="widget widget--weather">
      <div className="widget__head">
        <span className="widget__kind">clima · {whenLabel}</span>
        <span className="widget__loc">{data.city}</span>
      </div>
      <div className="widget__body">
        <div className="weather__main">
          <span className="weather__icon" aria-hidden>
            {icon}
          </span>
          <div>
            <div className="weather__temp">{tempStr}C</div>
            <div className="weather__cond">{data.condition}</div>
          </div>
        </div>
        <div className="weather__meta">
          {data.minC != null && data.maxC != null && (
            <span>
              min {Math.round(data.minC)}° · max {Math.round(data.maxC)}°
            </span>
          )}
          {data.rainPercent != null && data.rainPercent >= 5 && (
            <span>🌧 {data.rainPercent}%</span>
          )}
        </div>
      </div>
    </div>
  );
}
