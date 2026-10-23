// Briefing matinal: junta tasks (in-progress + todo) + frase motivacional
// num texto só. Disparado pelo Gemini Live quando o usuário abre a sessão
// com "bom dia"/"vamos começar"/etc.
//
// Clima foi removido: localização via ipapi.co tava errada (provavelmente
// mostrando IP da VPS/proxy) — voltar quando tiver fonte confiável.

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  listMyInProgressTasks,
  listMyTodoTasks,
  tasksToWidget,
  type ClickupTask,
} from './clickup.js';
import { getActiveWorkStore, formatRelativeAge } from './active-work.js';
import { getStorageStatus, type DiskInfo } from '@assistant/metrics';
import type { Widget, StorageWidget } from '../../shared/widgets.js';

const STATE_DIR = join(homedir(), 'pixxel', 'state');
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

/** Retorna true se o briefing ainda não rodou hoje (no fuso PY). */
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

const STORAGE_WIDGET_DELAY_MS = 2000;

// Usuário mora em Encarnación, PY — toda lógica de "hoje" é ancorada nesse fuso
// pra não depender da TZ do host (que pode estar em UTC, BRT etc).
const LOCAL_TZ = 'America/Asuncion';
const HOLIDAY_COUNTRY = 'PY';

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

// Cache de feriados nacionais por ano (Nager.Date, país = PY).
const holidaysCache = new Map<number, Array<{ date: string; name: string }>>();

async function fetchHolidaysForYear(
  year: number,
): Promise<Array<{ date: string; name: string }>> {
  const cached = holidaysCache.get(year);
  if (cached) return cached;
  const res = await fetch(
    `https://date.nager.at/api/v3/PublicHolidays/${year}/${HOLIDAY_COUNTRY}`,
  );
  if (!res.ok) throw new Error(`nager.date ${res.status}`);
  const raw = (await res.json()) as Array<{
    date: string;
    localName?: string;
    name?: string;
  }>;
  // localName vem em espanhol pra PY; é o que faz sentido narrar.
  const data = raw.map((h) => ({
    date: h.date,
    name: h.localName || h.name || 'Feriado',
  }));
  holidaysCache.set(year, data);
  return data;
}

type TodayObservance = {
  // Frase pronta pra entrar no briefing, já com prefixo de aviso.
  line: string;
  // Feriado nacional bate em dia não-útil — usado pra suprimir nudge de
  // "continuar trabalho de ontem" e tirar widgets ruidosos.
  isNationalHoliday: boolean;
  name: string;
};

// Datas comemorativas que NÃO são feriado nacional em PY mas valem menção
// no briefing. Mantido enxuto e localmente válido — datas BR foram removidas
// porque o usuário mora em Encarnación, PY.
function specialDateForToday(parts: LocalDateParts): string | null {
  const { month, day } = parts;
  if (month === 2 && day === 14) return 'Día de los Enamorados';
  if (month === 3 && day === 8) return 'Día Internacional de la Mujer';
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

/** Hora local atual em PY (0-23). */
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
  if (period === 'morning') return 'Bom dia!';
  if (period === 'afternoon') return 'Boa tarde!';
  return 'Boa noite!';
}

async function detectTodayObservance(
  parts: LocalDateParts,
): Promise<TodayObservance | null> {
  let national: { date: string; name: string } | undefined;
  try {
    const list = await fetchHolidaysForYear(parts.year);
    // Feriado nacional tem prioridade sobre data comemorativa local.
    national = list.find((h) => h.date === parts.iso);
  } catch {
    // segue sem feriado nacional — datas especiais ainda podem aplicar
  }

  if (national) {
    return {
      line: `Atenção: hoje é ${national.name} — feriado nacional no Paraguai, não é dia útil.`,
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

function buildStorageWidget(disks: DiskInfo[]): StorageWidget {
  return {
    kind: 'storage',
    scope: 'single',
    disks: disks.map((d) => ({
      mount: d.mount,
      fstype: d.fstype,
      totalBytes: d.totalBytes,
      usedBytes: d.usedBytes,
      availBytes: d.availBytes,
      usedPercent: d.usedPercent,
    })),
  };
}

function formatGB(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  return `${gb.toFixed(1)} GB`;
}

async function fetchStorage(): Promise<{ line: string; disks: DiskInfo[] }> {
  try {
    const r = await getStorageStatus('/');
    const d = r.disks[0];
    if (!d) return { line: '', disks: [] };
    return {
      line: `Disco principal com ${formatGB(d.availBytes)} livres (${d.usedPercent}% usado).`,
      disks: r.disks,
    };
  } catch {
    return { line: '', disks: [] };
  }
}

const MOTIVATIONAL = [
  'O segredo de avançar é começar.',
  'Disciplina é fazer o que precisa ser feito mesmo quando não tá afim.',
  'Foco no progresso, não na perfeição.',
  'Pequenos passos diários viram grandes resultados.',
  'Hoje é um bom dia pra resolver aquilo que tava enrolando.',
  'Você não precisa estar perfeito, precisa estar começado.',
  'O melhor momento pra fazer algo que importa é agora.',
  'Cada bug resolvido é uma vitória. Comemora.',
  'A meta não é fazer tudo — é fazer o que importa hoje.',
  'Hoje você tem 24 horas. Use 1 ou 2 bem usadas e o dia já vale.',
  'Confia no processo. Resultado é consequência.',
  'Energia segue atenção. Escolhe onde colocar a sua.',
  'Feito é melhor que perfeito.',
  'Comece pelo mais difícil enquanto a mente tá fresca.',
  'Não dá pra controlar tudo, mas dá pra controlar o próximo passo.',
];

function pickMotivational(): string {
  // Pega baseado no dia do ano pra mesma frase no mesmo dia (consistência),
  // mas rotaciona conforme avança.
  const start = new Date(new Date().getFullYear(), 0, 0).getTime();
  const dayOfYear = Math.floor((Date.now() - start) / 86_400_000);
  return MOTIVATIONAL[dayOfYear % MOTIVATIONAL.length];
}

function taskName(t: ClickupTask): string {
  return t.name;
}

const NUMBER_PT: Record<number, string> = {
  1: 'uma',
  2: 'duas',
  3: 'três',
  4: 'quatro',
  5: 'cinco',
  6: 'seis',
  7: 'sete',
  8: 'oito',
  9: 'nove',
  10: 'dez',
};

function num(n: number): string {
  return NUMBER_PT[n] ?? String(n);
}

function narrateInProgress(tasks: ClickupTask[]): string {
  if (tasks.length === 0) return '';
  const n = tasks.length;
  const head = tasks.slice(0, 3).map(taskName).join(', ');
  const tail = n > 3 ? `, mais ${n - 3} outras` : '';
  if (n === 1) return `Você tem uma tarefa em andamento: ${head}.`;
  return `Você tem ${num(n)} tarefas em andamento: ${head}${tail}.`;
}

function narrateTodo(tasks: ClickupTask[]): string {
  if (tasks.length === 0) return '';
  const n = tasks.length;
  const head = tasks.slice(0, 3).map(taskName).join(', ');
  const tail = n > 3 ? `, mais ${n - 3} outras` : '';
  if (n === 1) return `E uma pendente pra começar: ${head}.`;
  return `E ${num(n)} pendentes pra começar: ${head}${tail}.`;
}

export async function buildMorningBriefing(): Promise<{
  text: string;
  widgets: Widget[];
  widgetDelaysMs: number[];
  meta: {
    inProgressCount: number;
    todoCount: number;
    clickupOk: boolean;
    holiday: { name: string; isNationalHoliday: boolean } | null;
  };
}> {
  const localParts = getLocalDateParts();
  const [inProgress, todo, storage, observance] = await Promise.all([
    listMyInProgressTasks().catch(() => null),
    listMyTodoTasks().catch(() => null),
    fetchStorage(),
    detectTodayObservance(localParts),
  ]);
  const storageLine = storage.line;

  const dow = localParts.weekday;
  const isWeekend = dow === 0 || dow === 6;
  const isHoliday = observance?.isNationalHoliday ?? false;
  // Em fim de semana ou feriado nacional, tarefas em aberto viram ruído.
  const skipTasks = isWeekend || isHoliday;

  const period = getDayPeriod();
  const parts: string[] = [greetingFor(period)];
  parts.push(narrateTodayDate(localParts));
  if (observance) parts.push(observance.line);

  const clickupOk = inProgress != null && todo != null;
  if (!skipTasks) {
    if (clickupOk) {
      const inProgressLine = narrateInProgress(inProgress!);
      const todoLine = narrateTodo(todo!);
      if (!inProgressLine && !todoLine) {
        parts.push('Você não tem nenhuma tarefa pendente nem em andamento.');
      } else {
        if (inProgressLine) parts.push(inProgressLine);
        if (todoLine) parts.push(todoLine);
      }
    } else {
      parts.push('Não consegui buscar as tarefas no ClickUp agora.');
    }
  }

  if (storageLine) parts.push(storageLine);

  // Em feriado nacional ou fim de semana o nudge "quer continuar?" vira ruído — pula.
  if (isHoliday) {
    parts.push('Aproveita o dia. Algo que eu possa ajudar?');
  } else if (isWeekend) {
    parts.push('Bom fim de semana. Algo que eu possa ajudar?');
  } else {
    const lastUnfinished = getActiveWorkStore().lastUnfinished(7);
    if (lastUnfinished) {
      const age = formatRelativeAge(lastUnfinished.startedAt);
      parts.push(
        `Você estava trabalhando em "${lastUnfinished.description}" (começou ${age}). Quer continuar nessa?`,
      );
    } else {
      parts.push('O que vamos fazer agora?');
    }
  }

  const widgets: Widget[] = [];
  const widgetDelaysMs: number[] = [];
  if (!skipTasks && inProgress && inProgress.length > 0) {
    widgets.push(tasksToWidget('Em andamento', inProgress));
    widgetDelaysMs.push(0);
  }
  if (!skipTasks && todo && todo.length > 0) {
    widgets.push(tasksToWidget('Pendentes', todo));
    widgetDelaysMs.push(0);
  }
  // Em feriado/fim de semana, suprime widget de disco pra não poluir a tela
  // com info operacional num dia que não é de trabalho.
  if (storage.disks.length > 0 && !isHoliday && !isWeekend) {
    widgets.push(buildStorageWidget(storage.disks));
    widgetDelaysMs.push(STORAGE_WIDGET_DELAY_MS);
  }

  return {
    text: parts.join(' '),
    widgets,
    widgetDelaysMs,
    meta: {
      inProgressCount: inProgress?.length ?? 0,
      todoCount: todo?.length ?? 0,
      clickupOk,
      holiday: observance
        ? { name: observance.name, isNationalHoliday: observance.isNationalHoliday }
        : null,
    },
  };
}
