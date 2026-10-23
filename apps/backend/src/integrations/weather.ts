// Clima sempre de Jaguaruna - SC: a API roda num servidor de casa, então a
// geolocalização por IP apontaria pro lugar errado. Forecast via Open-Meteo
// (free, sem key).

import type { WeatherWidget } from '@assistant/shared/widgets';

export type WeatherResult = { text: string; widget?: WeatherWidget };

// Coordenadas fixas de Jaguaruna - SC, no fuso de Brasília.
const HOME = { latitude: -28.62145, longitude: -49.02529, city: 'Jaguaruna' };

const WMO_CODES: Record<number, string> = {
  0: 'céu limpo',
  1: 'predominantemente limpo',
  2: 'parcialmente nublado',
  3: 'nublado',
  45: 'nevoeiro',
  48: 'nevoeiro com geada',
  51: 'garoa fraca',
  53: 'garoa moderada',
  55: 'garoa intensa',
  61: 'chuva fraca',
  63: 'chuva moderada',
  65: 'chuva forte',
  71: 'neve fraca',
  73: 'neve moderada',
  75: 'neve forte',
  80: 'pancadas de chuva fracas',
  81: 'pancadas de chuva moderadas',
  82: 'pancadas de chuva fortes',
  95: 'tempestade',
  96: 'tempestade com granizo leve',
  99: 'tempestade com granizo forte',
};

function describeCode(code: number | undefined): string {
  if (code == null) return 'tempo indefinido';
  return WMO_CODES[code] ?? `código ${code}`;
}

export async function fetchWeather(
  when: 'today' | 'tomorrow',
): Promise<WeatherResult> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${HOME.latitude}&longitude=${HOME.longitude}` +
    `&current=temperature_2m,weather_code,relative_humidity_2m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=America/Sao_Paulo&forecast_days=2`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    console.warn('[weather] open-meteo fetch failed:', err);
    return { text: 'Não consegui falar com o serviço de clima agora.' };
  }
  if (!res.ok) return { text: 'O serviço de clima respondeu com erro.' };

  const data = (await res.json()) as {
    current?: { temperature_2m?: number; weather_code?: number };
    daily?: {
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: number[];
    };
  };

  if (when === 'today') {
    const t = data.current?.temperature_2m;
    const code = data.current?.weather_code;
    const max = data.daily?.temperature_2m_max?.[0];
    const min = data.daily?.temperature_2m_min?.[0];
    const rain = data.daily?.precipitation_probability_max?.[0];
    if (t == null || code == null) return { text: 'Sem dados de clima agora.' };
    const condition = describeCode(code);
    let text = `Em ${HOME.city} estão ${Math.round(t)}°C, ${condition}.`;
    if (min != null && max != null) {
      text += ` Mínima de ${Math.round(min)}°C e máxima de ${Math.round(max)}°C.`;
    }
    if (rain != null && rain >= 30) text += ` ${rain}% de chance de chuva hoje.`;
    return {
      text,
      widget: {
        kind: 'weather',
        when: 'today',
        city: HOME.city,
        tempC: t,
        weatherCode: code,
        condition,
        minC: min ?? undefined,
        maxC: max ?? undefined,
        rainPercent: rain ?? undefined,
      },
    };
  }

  // tomorrow
  const code = data.daily?.weather_code?.[1];
  const max = data.daily?.temperature_2m_max?.[1];
  const min = data.daily?.temperature_2m_min?.[1];
  const rain = data.daily?.precipitation_probability_max?.[1];
  if (code == null || max == null || min == null) return { text: 'Sem previsão pra amanhã.' };
  const condition = describeCode(code);
  let text = `Amanhã em ${HOME.city}: ${condition}, mínima de ${Math.round(min)}°C e máxima de ${Math.round(max)}°C.`;
  if (rain != null && rain >= 30) text += ` ${rain}% de chance de chuva.`;
  return {
    text,
    widget: {
      kind: 'weather',
      when: 'tomorrow',
      city: HOME.city,
      weatherCode: code,
      condition,
      minC: min,
      maxC: max,
      rainPercent: rain ?? undefined,
    },
  };
}
