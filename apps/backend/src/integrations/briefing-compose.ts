// Texto falado e segmentos do briefing em palco. Função pura: recebe os dados
// já buscados e devolve o texto que a voz lê (verbatim) junto do widget com um
// card por trecho. Cada trecho leva uma "deixa" (cue) que o desktop procura na
// transcrição ao vivo para trocar de card na hora certa.

import { makeCue } from '@assistant/shared/briefing-cues';
import type { BriefingSegment, BriefingWidget, NewsArea, WeatherWidget } from '@assistant/shared/widgets';
import type { NewsItem } from './news.js';

export type BriefingInput = {
  greeting: string;
  dateLine: string;
  weekday: string;
  day: number;
  monthYear: string;
  observance: { name: string; line: string; isNationalHoliday: boolean } | null;
  weather: WeatherWidget | null;
  news: NewsItem[];
};

const CONECTOR: Record<NewsArea, string> = {
  mundo: 'No mundo,',
  tecnologia: 'Na tecnologia,',
  economia: 'Na economia,',
};

const PLACE = 'Jaguaruna · SC';

/** Tira a pontuação final do título, pra a frase falada fechar com um ponto só. */
function stripFinalPunctuation(title: string): string {
  return title.trim().replace(/[\s.!?…:;,]+$/u, '');
}

function weatherSay(w: WeatherWidget & { tempC: number }): string {
  let say = `Em ${w.city}, agora faz ${Math.round(w.tempC)} graus, ${w.condition}.`;
  const rain = w.rainPercent !== undefined ? Math.round(w.rainPercent) : undefined;
  if (w.minC !== undefined && w.maxC !== undefined) {
    say += ` Mínima de ${Math.round(w.minC)} e máxima de ${Math.round(w.maxC)}`;
    say += rain !== undefined ? `, com ${rain}% de chance de chuva.` : '.';
  } else if (rain !== undefined) {
    say += ` Chance de chuva de ${rain}%.`;
  }
  return say;
}

export function composeBriefing(input: BriefingInput): {
  text: string;
  widget: BriefingWidget;
  news: Array<{ area: NewsArea; title: string; url: string }>;
} {
  const { observance, weather } = input;
  const segments: BriefingSegment[] = [];

  const dateSay = input.greeting + ' ' + input.dateLine + (observance ? ' ' + observance.line : '');
  segments.push({
    kind: 'date',
    say: dateSay,
    cue: makeCue(input.dateLine),
    weekday: input.weekday,
    day: input.day,
    monthYear: input.monthYear,
    ...(observance
      ? { observance: { name: observance.name, type: observance.isNationalHoliday ? ('holiday' as const) : ('observance' as const) } }
      : {}),
  });

  // Sem temperatura atual não há o que dizer sobre o clima.
  if (weather && weather.tempC !== undefined) {
    const say = weatherSay({ ...weather, tempC: weather.tempC });
    segments.push({
      kind: 'weather',
      say,
      cue: makeCue(say),
      place: PLACE,
      tempC: Math.round(weather.tempC),
      condition: weather.condition,
      weatherCode: weather.weatherCode,
      minC: weather.minC !== undefined ? Math.round(weather.minC) : undefined,
      maxC: weather.maxC !== undefined ? Math.round(weather.maxC) : undefined,
      rainPercent: weather.rainPercent !== undefined ? Math.round(weather.rainPercent) : undefined,
    });
  }

  for (const n of input.news) {
    const say = `${CONECTOR[n.area]} ${stripFinalPunctuation(n.title)}.`;
    segments.push({
      kind: 'news',
      say,
      cue: makeCue(say),
      area: n.area,
      title: n.title,
      summary: n.summary,
      url: n.url,
      imageUrl: n.imageUrl,
      source: n.source,
      publishedAt: n.publishedAt,
    });
  }

  const closing = input.news.length > 0 ? 'Quer que eu abra alguma delas?' : 'Em que posso ajudar, senhor?';
  const text = [...segments.map((s) => s.say), closing].join(' ');

  return {
    text,
    widget: { kind: 'briefing', segments },
    news: input.news.map((n) => ({ area: n.area, title: n.title, url: n.url })),
  };
}
