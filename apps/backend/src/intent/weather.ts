import { logger } from '../logger.js';

type Geo = { latitude: number; longitude: number; city: string; country: string };

async function lookupGeo(): Promise<Geo | null> {
  try {
    const res = await fetch('https://ipapi.co/json/', {
      headers: { 'user-agent': 'jarvis-assistant/0.1' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      latitude?: number;
      longitude?: number;
      city?: string;
      country_name?: string;
    };
    if (data.latitude == null || data.longitude == null) return null;
    return {
      latitude: data.latitude,
      longitude: data.longitude,
      city: data.city ?? 'sua localização',
      country: data.country_name ?? '',
    };
  } catch (err) {
    logger.warn({ err }, 'ipapi failed');
    return null;
  }
}

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

export async function fetchWeatherText(when: 'today' | 'tomorrow'): Promise<string> {
  const geo = await lookupGeo();
  if (!geo) {
    return 'Não consegui descobrir sua localização agora. Verifique sua conexão e tente de novo.';
  }

  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${geo.latitude}&longitude=${geo.longitude}` +
    `&current=temperature_2m,weather_code,relative_humidity_2m` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&timezone=auto&forecast_days=2`;

  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    logger.warn({ err }, 'open-meteo fetch failed');
    return 'Não consegui falar com o serviço de clima agora.';
  }
  if (!res.ok) {
    return 'O serviço de clima respondeu com erro. Tenta de novo daqui a pouco.';
  }
  const data = (await res.json()) as {
    current?: { temperature_2m?: number; weather_code?: number; relative_humidity_2m?: number };
    daily?: {
      time?: string[];
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
    if (t == null || code == null) return 'Não recebi dados de clima válidos.';
    let txt = `Em ${geo.city} agora estão ${Math.round(t)}°C, ${describeCode(code)}.`;
    if (min != null && max != null) {
      txt += ` Mínima de ${Math.round(min)}°C e máxima de ${Math.round(max)}°C.`;
    }
    if (rain != null && rain >= 30) {
      txt += ` ${rain}% de chance de chuva hoje.`;
    }
    return txt;
  }

  // tomorrow
  const code = data.daily?.weather_code?.[1];
  const max = data.daily?.temperature_2m_max?.[1];
  const min = data.daily?.temperature_2m_min?.[1];
  const rain = data.daily?.precipitation_probability_max?.[1];
  if (code == null || max == null || min == null) {
    return 'Ainda não tenho previsão pra amanhã.';
  }
  let txt = `Amanhã em ${geo.city}: ${describeCode(code)}, mínima de ${Math.round(min)}°C e máxima de ${Math.round(max)}°C.`;
  if (rain != null && rain >= 30) {
    txt += ` ${rain}% de chance de chuva.`;
  }
  return txt;
}
