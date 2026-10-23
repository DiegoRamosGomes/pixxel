// Briefing matinal em palco: data (com feriado ou data comemorativa), clima de
// Jaguaruna e as três notícias do dia (mundo, tecnologia e economia). Feriados,
// clima e notícias são buscados em paralelo, cada um com orçamento de tempo:
// se estourar ou falhar, o trecho some e o resto do briefing sai normal.
// Disparado pelo Gemini Live quando o usuário abre a sessão com "bom dia".

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { NewsArea, Widget, WeatherWidget } from '@assistant/shared/widgets';
import { dataPath } from '../data-dir.js';
import { composeBriefing } from './briefing-compose.js';
import { fetchNews, type NewsItem } from './news.js';
import { fetchWeather } from './weather.js';

const STATE_DIR = dataPath('state');
const BRIEFING_STATE_FILE = join(STATE_DIR, 'briefing-state.json');

type BriefingState = { lastBriefingDate: string };

async function readBriefingState(): Promise<BriefingState | null> {
  try {
    const txt = await fs.readFile(BRIEFING_STATE_FILE, 'utf-8');
    return JSON.parse(txt) as BriefingState;
  } catch {
    return null;
  }
}

async function writeBriefingState(s: BriefingState): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(BRIEFING_STATE_FILE, JSON.stringify(s), 'utf-8');
  } catch (err) {
    console.warn('[briefing] persist falhou:', err);
  }
}

/** Retorna true se o briefing ainda não rodou hoje (no fuso de Brasília). */
export async function isFirstBriefingOfDay(): Promise<boolean> {
  const state = await readBriefingState();
  const today = getLocalDateParts().iso;
  return state?.lastBriefingDate !== today;
}

/** Marca o briefing de hoje como já feito. */
export async function markBriefingDoneToday(): Promise<void> {
  const today = getLocalDateParts().iso;
  await writeBriefingState({ lastBriefingDate: today });
}

// Usuário mora no Brasil — toda lógica de "hoje" é ancorada no fuso de Brasília
// pra não depender da TZ do host (que pode estar em UTC etc).
const LOCAL_TZ = 'America/Sao_Paulo';
const HOLIDAY_COUNTRY = 'BR';

type LocalDateParts = {
  year: number;
  month: number; // 1-12
  day: number;   // 1-31
  weekday: number; // 0=domingo
  iso: string; // YYYY-MM-DD no fuso local
};

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

function getLocalDateParts(now: Date = new Date()): LocalDateParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const year = Number(get('year'));
  const month = Number(get('month'));
  const day = Number(get('day'));
  const weekday = WEEKDAY_INDEX[get('weekday')] ?? 0;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return { year, month, day, weekday, iso };
}

type Holiday = {
  date: string;
  name: string;
  // Ponto facultativo (ex.: Carnaval) — vale menção, mas é dia útil.
  optional: boolean;
};

// Cache de feriados nacionais por ano (Nager.Date, país = BR).
const holidaysCache = new Map<number, Holiday[]>();

/** Timeout do Nager.Date; estourou, o briefing segue sem feriado. */
const HOLIDAYS_FETCH_TIMEOUT_MS = 3500;

async function fetchHolidaysForYear(year: number): Promise<Holiday[]> {
  const cached = holidaysCache.get(year);
  if (cached) return cached;
  const res = await fetch(
    `https://date.nager.at/api/v3/PublicHolidays/${year}/${HOLIDAY_COUNTRY}`,
    { signal: AbortSignal.timeout(HOLIDAYS_FETCH_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`nager.date ${res.status}`);
  const raw = (await res.json()) as Array<{
    date: string;
    localName?: string;
    name?: string;
    global?: boolean;
    types?: string[];
  }>;
  // global=false é feriado estadual (ex.: 9 de julho só em SP) — fica de fora.
  // localName vem em português pra BR; é o que faz sentido narrar.
  const data = raw
    .filter((h) => h.global !== false)
    .map((h) => ({
      date: h.date,
      name: h.localName || h.name || 'Feriado',
      optional: !(h.types ?? ['Public']).includes('Public'),
    }));
  holidaysCache.set(year, data);
  return data;
}

type TodayObservance = {
  // Frase pronta pra entrar no briefing, já com prefixo de aviso.
  line: string;
  // Feriado nacional bate em dia não-útil.
  isNationalHoliday: boolean;
  name: string;
};

// Datas comemorativas que NÃO são feriado nacional no Brasil mas valem menção
// no briefing. Mantido enxuto.
function specialDateForToday(parts: LocalDateParts): string | null {
  const { month, day } = parts;
  if (month === 3 && day === 8) return 'Dia Internacional da Mulher';
  if (month === 6 && day === 12) return 'Dia dos Namorados';
  return null;
}

const WEEKDAY_PT = [
  'domingo',
  'segunda-feira',
  'terça-feira',
  'quarta-feira',
  'quinta-feira',
  'sexta-feira',
  'sábado',
];
const MONTH_PT = [
  'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
];

function narrateTodayDate(parts: LocalDateParts): string {
  return `Hoje é ${WEEKDAY_PT[parts.weekday]}, ${parts.day} de ${MONTH_PT[parts.month - 1]} de ${parts.year}.`;
}

export type DayPeriod = 'morning' | 'afternoon' | 'night';

/** Hora local atual no fuso de Brasília (0-23). */
function getLocalHour(now: Date = new Date()): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCAL_TZ,
    hour: '2-digit',
    hour12: false,
  });
  return parseInt(fmt.format(now), 10);
}

export function getDayPeriod(now: Date = new Date()): DayPeriod {
  const h = getLocalHour(now);
  if (h >= 5 && h < 12) return 'morning';
  if (h >= 12 && h < 18) return 'afternoon';
  return 'night';
}

function greetingFor(period: DayPeriod): string {
  if (period === 'morning') return 'Bom dia, senhor.';
  if (period === 'afternoon') return 'Boa tarde, senhor.';
  return 'Boa noite, senhor.';
}

async function detectTodayObservance(
  parts: LocalDateParts,
  fetchHolidays: (year: number) => Promise<Holiday[]>,
): Promise<TodayObservance | null> {
  let national: Holiday | undefined;
  try {
    const list = await fetchHolidays(parts.year);
    // Feriado nacional tem prioridade sobre data comemorativa local.
    national = list.find((h) => h.date === parts.iso);
  } catch {
    // segue sem feriado nacional — datas especiais ainda podem aplicar
  }

  if (national?.optional) {
    return {
      line: `Atenção: hoje é ${national.name} — ponto facultativo.`,
      isNationalHoliday: false,
      name: national.name,
    };
  }

  if (national) {
    return {
      line: `Atenção: hoje é ${national.name} — feriado nacional, não é dia útil.`,
      isNationalHoliday: true,
      name: national.name,
    };
  }

  const special = specialDateForToday(parts);
  if (special) {
    return {
      line: `Atenção: hoje é ${special} — data comemorativa.`,
      isNationalHoliday: false,
      name: special,
    };
  }

  return null;
}

export type BriefingDeps = {
  now: () => Date;
  fetchWeather: () => Promise<WeatherWidget | null>;
  fetchNews: () => Promise<NewsItem[]>;
  fetchHolidays?: (year: number) => Promise<Holiday[]>;
};

/** Tempo máximo que cada fonte (feriados, clima, notícias) tem pra responder. */
export const BRIEFING_FETCH_BUDGET_MS = 5000;

const defaultDeps: BriefingDeps = {
  now: () => new Date(),
  fetchWeather: () => fetchWeather('today').then((r) => r.widget ?? null),
  fetchNews: () => fetchNews(),
  fetchHolidays: fetchHolidaysForYear,
};

// Corre a busca contra o orçamento; timeout ou erro viram o valor de reserva.
// O timer é limpo quando a busca termina antes, pra não segurar o processo.
async function withBudget<T>(run: () => Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), BRIEFING_FETCH_BUDGET_MS);
  });
  try {
    return await Promise.race([run().catch(() => fallback), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function buildMorningBriefing(deps: Partial<BriefingDeps> = {}): Promise<{
  text: string;
  widgets: Widget[];
  widgetDelaysMs: number[];
  meta: {
    news: Array<{ area: NewsArea; title: string; url: string }>;
    holiday: { name: string; isNationalHoliday: boolean } | null;
  };
}> {
  const d = { ...defaultDeps, ...deps };
  const fetchHolidays = d.fetchHolidays ?? fetchHolidaysForYear;
  const now = d.now();
  const localParts = getLocalDateParts(now);

  const [observance, weather, news] = await Promise.all([
    withBudget(() => detectTodayObservance(localParts, fetchHolidays), null),
    withBudget(() => d.fetchWeather(), null),
    withBudget(() => d.fetchNews(), [] as NewsItem[]),
  ]);

  const composed = composeBriefing({
    greeting: greetingFor(getDayPeriod(now)),
    dateLine: narrateTodayDate(localParts),
    weekday: WEEKDAY_PT[localParts.weekday],
    day: localParts.day,
    monthYear: `${MONTH_PT[localParts.month - 1]} de ${localParts.year}`,
    observance,
    weather,
    news,
  });

  return {
    text: composed.text,
    widgets: [composed.widget],
    widgetDelaysMs: [0],
    meta: {
      news: composed.news,
      holiday: observance
        ? { name: observance.name, isNationalHoliday: observance.isNationalHoliday }
        : null,
    },
  };
}
