// Cota local pra REST do Gemini (vision + youtube-summary). O free tier
// atual da chave bate em 20 RPD pro 2.5-flash; o lite tem mais mas mantemos
// o mesmo guard pra ter previsibilidade. Persiste em ~/pixxel/state/.

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../data-dir.js';

const FILE = dataPath('state', 'gemini-quota.json');

const DAILY_LIMIT = 20;
const WARN_AT = 18; // ao bater 18 já avisa
const LAST_AT = 19; // ao bater 19 avisa que é a última

type State = { date: string; count: number };

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

let cached: State | null = null;

async function load(): Promise<State> {
  if (cached && cached.date === todayKey()) return cached;
  try {
    const raw = await fs.readFile(FILE, 'utf-8');
    const parsed = JSON.parse(raw) as State;
    if (parsed.date === todayKey()) {
      cached = parsed;
      return parsed;
    }
  } catch {
    /* não existe ou inválido */
  }
  cached = { date: todayKey(), count: 0 };
  return cached;
}

async function save(state: State): Promise<void> {
  cached = state;
  try {
    await fs.mkdir(dataPath('state'), { recursive: true });
    await fs.writeFile(FILE, JSON.stringify(state), 'utf-8');
  } catch (err) {
    console.warn('[gemini-quota] falha ao persistir:', err);
  }
}

export type QuotaCheck =
  | { ok: true; count: number; warn?: string }
  | { ok: false; reason: string };

/**
 * Tenta reservar 1 request. Se passar, incrementa contagem e devolve ok=true,
 * com opcional warn pra o tool incluir na resposta. Se já estiver no teto,
 * devolve ok=false e a tool deve recusar.
 */
export async function reserveGeminiRequest(): Promise<QuotaCheck> {
  const s = await load();
  if (s.count >= DAILY_LIMIT) {
    return {
      ok: false,
      reason:
        `cota diária do Gemini text/vision esgotada (${DAILY_LIMIT}/dia). ` +
        `reseta meia-noite UTC.`,
    };
  }
  const next = s.count + 1;
  await save({ date: s.date, count: next });
  let warn: string | undefined;
  if (next === LAST_AT) {
    warn =
      `[ALERTA QUOTA] Esta foi a ${LAST_AT}ª request do dia — só sobrou MAIS UMA ` +
      `antes de bloquear até amanhã. Avise o usuário em primeira pessoa, frase ` +
      `curta tipo "tô na última request do dia, depois dessa só amanhã".`;
  } else if (next === WARN_AT) {
    warn =
      `[ALERTA QUOTA] Já usei ${WARN_AT}/${DAILY_LIMIT} requests do dia (Gemini ` +
      `text/vision). Avise o usuário em primeira pessoa, frase curta tipo ` +
      `"tô chegando perto do limite diário do Gemini".`;
  }
  return { ok: true, count: next, warn };
}

export async function getGeminiQuotaStatus(): Promise<{
  used: number;
  limit: number;
  date: string;
}> {
  const s = await load();
  return { used: s.count, limit: DAILY_LIMIT, date: s.date };
}
