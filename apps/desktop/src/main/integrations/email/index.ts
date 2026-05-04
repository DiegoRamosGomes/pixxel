// API pública da integração de emails. State persistido em
// ~/pixxel/state/email.json: watermark UID + cache de emails recentes
// (pra rotular feedback "o último importante" sem precisar refazer fetch).

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  applyLabelsAndMarkRead,
  fetchRecent,
  fetchUnread,
  isGmailAvailable,
  type EmailMessage,
} from './gmail.js';
import { classifyEmail, embedEmail } from './classifier.js';
import { appendLabel, loadLabels, removeLabel, labelStats } from './labels.js';
import { indexEntry, search as semanticSearch } from '../embeddings.js';

export { isGmailAvailable };

const STATE_DIR = join(homedir(), 'pixxel', 'state');
const STATE_FILE = join(STATE_DIR, 'email.json');
const RECENT_LIMIT = 50;

export type ProcessedEmail = {
  /** ID interno (não é o UID — UID some quando email muda de pasta). */
  id: string;
  uid: number;
  from: string;
  subject: string;
  snippet: string;
  date: string | null;
  important: boolean;
  /** Indica como foi classificado: rule | knn | llm | feedback (rotulado pelo usuário). */
  source: string;
  /** Embedding cacheado pra rotulagem rápida posterior. */
  vector?: number[];
  processedAt: string;
};

type State = {
  version: 1;
  lastUid: number;
  recent: ProcessedEmail[];
  /** Quantos emails já foram indexados via backfill. Usado pra rodar uma vez. */
  backfilledCount?: number;
};

let cache: State | null = null;

async function loadState(): Promise<State> {
  if (cache) return cache;
  try {
    const buf = await fs.readFile(STATE_FILE, 'utf8');
    cache = JSON.parse(buf) as State;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') {
      cache = { version: 1, lastUid: 0, recent: [] };
    } else {
      throw err;
    }
  }
  return cache;
}

async function saveState(state: State): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  cache = state;
}

export type CycleResult = {
  fetched: number;
  important: ProcessedEmail[];
  notImportant: ProcessedEmail[];
  errors?: string[];
};

/**
 * Roda um ciclo: fetch unread → classifica → aplica labels/marca lido →
 * atualiza watermark e cache de recentes.
 *
 * `dryRun=true` pula apply de labels — útil pra primeira execução manual.
 */
export async function runEmailCycle(opts: { dryRun?: boolean } = {}): Promise<CycleResult> {
  if (!isGmailAvailable()) {
    return { fetched: 0, important: [], notImportant: [], errors: ['gmail não configurado'] };
  }
  const state = await loadState();
  let messages: EmailMessage[];
  try {
    messages = await fetchUnread({ limit: 50, sinceUid: state.lastUid });
  } catch (err) {
    return {
      fetched: 0,
      important: [],
      notImportant: [],
      errors: [err instanceof Error ? err.message : 'fetch falhou'],
    };
  }
  if (messages.length === 0) {
    return { fetched: 0, important: [], notImportant: [] };
  }

  const important: ProcessedEmail[] = [];
  const notImportant: ProcessedEmail[] = [];
  const toApply: Array<{ uid: number; important: boolean }> = [];

  for (const m of messages) {
    let result;
    try {
      result = await classifyEmail(m);
    } catch (err) {
      console.warn('[email] classify falhou, marcando como não-importante:', err);
      result = { important: false, source: 'fallback' as const };
    }
    const processed: ProcessedEmail = {
      id: randomUUID(),
      uid: m.uid,
      from: m.from,
      subject: m.subject,
      snippet: m.snippet,
      date: m.date ? m.date.toISOString() : null,
      important: result.important,
      source: result.source,
      vector: result.vector,
      processedAt: new Date().toISOString(),
    };
    if (result.important) important.push(processed);
    else notImportant.push(processed);
    toApply.push({ uid: m.uid, important: result.important });

    // Indexa pra busca semântica futura ("último email sobre X").
    // Falha aqui não derruba o ciclo.
    try {
      const text = `De: ${m.from}\nAssunto: ${m.subject}\n\n${m.text || m.snippet}`;
      await indexEntry({
        id: `email:${processed.id}`,
        kind: 'email',
        title: `${m.from} — ${m.subject}`,
        text,
        metadata: {
          emailId: processed.id,
          uid: m.uid,
          from: m.from,
          subject: m.subject,
          date: processed.date,
          important: result.important,
        },
      });
    } catch (err) {
      console.warn('[email] index falhou:', err);
    }
  }

  let labelError: string | null = null;
  if (!opts.dryRun) {
    try {
      await applyLabelsAndMarkRead(toApply);
    } catch (err) {
      labelError = err instanceof Error ? err.message : 'apply labels falhou';
      console.warn('[email] apply labels falhou:', labelError);
    }
  }

  // Atualiza watermark mesmo se label falhou — alternativa é reprocessar.
  // Aqui prefiro avançar e logar; pior caso é perder uma rotulagem.
  const newWatermark = Math.max(...messages.map((m) => m.uid));
  state.lastUid = Math.max(state.lastUid, newWatermark);
  state.recent = [...important, ...notImportant, ...state.recent].slice(0, RECENT_LIMIT);
  await saveState(state);

  return {
    fetched: messages.length,
    important,
    notImportant,
    errors: labelError ? [labelError] : undefined,
  };
}

export async function getRecent(): Promise<ProcessedEmail[]> {
  const s = await loadState();
  return s.recent;
}

export async function getRecentImportant(limit = 10): Promise<ProcessedEmail[]> {
  const s = await loadState();
  return s.recent.filter((e) => e.important).slice(0, limit);
}

/** Busca um email recente por descrição/sender/subject (fuzzy). */
export async function findRecentEmail(query: string): Promise<ProcessedEmail | null> {
  const s = await loadState();
  const q = query.toLowerCase().trim();
  if (!q) return null;
  // Heurística: prioriza match exato em from, depois subject, depois snippet.
  const ranked = s.recent
    .map((e) => {
      let score = 0;
      const from = e.from.toLowerCase();
      const subject = e.subject.toLowerCase();
      const snippet = e.snippet.toLowerCase();
      if (from.includes(q)) score += 3;
      if (subject.includes(q)) score += 2;
      if (snippet.includes(q)) score += 1;
      return { e, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.e ?? null;
}

/**
 * Marca um email recente como importante/não-importante (feedback do usuário).
 * Adiciona ao corpus rotulado pra KNN aprender. Re-embed se faltar vetor cacheado.
 */
export async function labelEmail(
  emailId: string,
  label: 'important' | 'not',
): Promise<{ ok: boolean; reason?: string; subject?: string }> {
  const s = await loadState();
  const e = s.recent.find((x) => x.id === emailId);
  if (!e) return { ok: false, reason: 'email não encontrado nos recentes' };

  let vector = e.vector;
  if (!vector) {
    try {
      vector = await embedEmail({
        uid: e.uid,
        from: e.from,
        subject: e.subject,
        snippet: e.snippet,
        date: null,
        text: e.snippet,
      });
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : 'embed falhou',
      };
    }
  }

  await appendLabel({
    id: e.id,
    label,
    from: e.from,
    subject: e.subject,
    snippet: e.snippet,
    vector,
    addedAt: new Date().toISOString(),
  });

  // Atualiza o estado pra refletir o novo rótulo na lista de recentes.
  e.important = label === 'important';
  e.source = 'feedback';
  e.vector = vector;
  await saveState(s);

  return { ok: true, subject: e.subject };
}

export async function getCorpusStats(): Promise<{
  total: number;
  important: number;
  not: number;
}> {
  const corpus = await loadLabels();
  return labelStats(corpus);
}

export async function unlabelEmail(emailId: string): Promise<boolean> {
  return removeLabel(emailId);
}

/**
 * Indexa os últimos N emails da INBOX pra busca semântica. Não classifica,
 * não toca em labels nem flags — apenas embed + index. Idempotente:
 * indexEntry pula re-embed quando o conteúdo não mudou (hash).
 */
export async function backfillEmails(
  limit = 100,
): Promise<{ ok: boolean; reason?: string; indexed: number; skipped: number }> {
  if (!isGmailAvailable()) {
    return { ok: false, reason: 'gmail não configurado', indexed: 0, skipped: 0 };
  }
  let messages: EmailMessage[];
  try {
    messages = await fetchRecent(limit);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'fetch falhou',
      indexed: 0,
      skipped: 0,
    };
  }

  let indexed = 0;
  let skipped = 0;
  for (const m of messages) {
    try {
      const text = `De: ${m.from}\nAssunto: ${m.subject}\n\n${m.text || m.snippet}`;
      const r = await indexEntry({
        // ID estável por UID — re-rodar o backfill não duplica.
        id: `email:uid-${m.uid}`,
        kind: 'email',
        title: `${m.from} — ${m.subject}`,
        text,
        metadata: {
          uid: m.uid,
          from: m.from,
          subject: m.subject,
          date: m.date ? m.date.toISOString() : null,
          // Não classificou — usa false como default. Pode rerankear depois.
          important: false,
          backfilled: true,
        },
      });
      if (r.embedded) indexed++;
      else skipped++;
    } catch (err) {
      console.warn(`[email/backfill] falha em uid=${m.uid}:`, err);
    }
  }

  const state = await loadState();
  state.backfilledCount = (state.backfilledCount ?? 0) + indexed;
  await saveState(state);

  return { ok: true, indexed, skipped };
}

export async function hasBackfilled(): Promise<boolean> {
  const s = await loadState();
  return (s.backfilledCount ?? 0) > 0;
}

export type EmailSearchHit = {
  emailId: string;
  uid: number;
  from: string;
  subject: string;
  date: string | null;
  important: boolean;
  snippet: string;
  score: number;
};

/**
 * Busca semântica nos emails já indexados. "Último email sobre vagas" →
 * embedda a query, casa por similaridade, ordena pelo combo
 * (relevância × recência) pra dar preferência ao mais recente.
 */
export async function searchEmails(
  query: string,
  limit = 5,
): Promise<EmailSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  // Pega top-15 por relevância pra ter de onde re-rankear por data.
  const hits = await semanticSearch(q, { kind: 'email', limit: 15 });
  if (hits.length === 0) return [];

  // Re-rank: score combinado prioriza recência quando relevância é parecida.
  // Decay exponencial: cada 30 dias reduz peso pela metade.
  const now = Date.now();
  const HALF_LIFE_MS = 30 * 24 * 3600_000;

  const ranked = hits
    .map((h) => {
      const meta = (h.metadata ?? {}) as Record<string, unknown>;
      const dateStr = typeof meta.date === 'string' ? meta.date : null;
      const ts = dateStr ? Date.parse(dateStr) : now;
      const ageMs = Math.max(0, now - ts);
      const recencyMult = Math.pow(0.5, ageMs / HALF_LIFE_MS);
      // Combina: 70% similaridade + 30% recência. Scores estão em ~0–1.
      const combined = 0.7 * h.score + 0.3 * recencyMult;
      return {
        h,
        combined,
        ts,
        meta,
      };
    })
    .sort((a, b) => b.combined - a.combined)
    .slice(0, limit);

  return ranked.map(({ h, meta, ts }) => ({
    emailId: String(meta.emailId ?? ''),
    uid: Number(meta.uid ?? 0),
    from: String(meta.from ?? ''),
    subject: String(meta.subject ?? ''),
    date: typeof meta.date === 'string' ? meta.date : null,
    important: Boolean(meta.important),
    snippet: h.snippet.replace(/^De:.*\n.*\n\n/, ''),
    score: ts ? h.score : 0,
  }));
}
