// Index semântico das memórias e worklogs. Usa Gemini Embedding 2 (768-dim
// pra economizar bytes — qualidade quase idêntica ao 3072 pro nosso uso).
//
// Persiste em ~/pixxel/state/embeddings.json. Cada entry tem hash do texto
// embedded — re-embed só roda se o texto mudou (evita estourar 1k RPD).
//
// API exposta:
//   indexEntry(id, kind, title, text, metadata?) — adiciona/atualiza
//   removeEntry(id)
//   search(query, kind?, limit=5) — top-N por cosine similarity
//   reindexMemoryVault(vault), reindexWorklogs() — bulk
//   initialize() — load + dispara re-index em background

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { MemoryVault } from '../memory.js';

const STATE_DIR = join(homedir(), 'pixxel', 'state');
const FILE = join(STATE_DIR, 'embeddings.json');
const WORKLOG_DIR = join(homedir(), 'pixxel', 'work-log');

const MODEL = 'gemini-embedding-2';
const DIM = 768;
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:embedContent`;

export type IndexKind = 'memory' | 'worklog' | 'email';

export type IndexEntry = {
  id: string; // ex: "memory:user_role" ou "worklog:2026-04-12T15-30-00.md"
  kind: IndexKind;
  title: string;
  snippet: string; // primeiros chars do texto, pra mostrar no resultado
  hash: string; // md5 do texto embedded
  vector: number[]; // L2-normalized
  metadata?: Record<string, unknown>;
  updatedAt: string;
};

type IndexFile = {
  version: 1;
  model: string;
  dim: number;
  entries: Record<string, IndexEntry>;
};

let cache: IndexFile | null = null;

function emptyIndex(): IndexFile {
  return { version: 1, model: MODEL, dim: DIM, entries: {} };
}

async function load(): Promise<IndexFile> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, 'utf-8');
    const parsed = JSON.parse(raw) as IndexFile;
    // Se trocou modelo/dim, descarta tudo (vetores incompatíveis).
    if (parsed.model !== MODEL || parsed.dim !== DIM) {
      console.log(
        `[embeddings] index obsoleto (model=${parsed.model} dim=${parsed.dim}) — reset`,
      );
      cache = emptyIndex();
      return cache;
    }
    cache = parsed;
    return cache;
  } catch {
    cache = emptyIndex();
    return cache;
  }
}

let saveTimer: NodeJS.Timeout | null = null;
async function persistDebounced(): Promise<void> {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!cache) return;
    try {
      await fs.mkdir(STATE_DIR, { recursive: true });
      await fs.writeFile(FILE, JSON.stringify(cache), 'utf-8');
    } catch (err) {
      console.warn('[embeddings] persist falhou:', err);
    }
  }, 1000);
}

function md5(s: string): string {
  return createHash('md5').update(s).digest('hex');
}

function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

export async function embed(
  text: string,
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_DOCUMENT',
): Promise<number[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY ausente');
  const res = await fetch(`${ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      outputDimensionality: DIM,
      taskType,
    }),
  });
  if (!res.ok) {
    const tx = await res.text().catch(() => '');
    throw new Error(`embed HTTP ${res.status} ${tx.slice(0, 120)}`);
  }
  const json = (await res.json()) as { embedding?: { values?: number[] } };
  const v = json.embedding?.values;
  if (!Array.isArray(v) || v.length === 0) throw new Error('embed resposta vazia');
  return normalize(v);
}

export async function indexEntry(args: {
  id: string;
  kind: IndexKind;
  title: string;
  text: string;
  metadata?: Record<string, unknown>;
}): Promise<{ embedded: boolean }> {
  const idx = await load();
  const hash = md5(args.text);
  const existing = idx.entries[args.id];
  if (existing && existing.hash === hash) {
    return { embedded: false }; // sem mudança, pula re-embed
  }
  const vector = await embed(args.text, 'RETRIEVAL_DOCUMENT');
  idx.entries[args.id] = {
    id: args.id,
    kind: args.kind,
    title: args.title,
    snippet: args.text.slice(0, 220),
    hash,
    vector,
    metadata: args.metadata,
    updatedAt: new Date().toISOString(),
  };
  await persistDebounced();
  return { embedded: true };
}

export async function removeEntry(id: string): Promise<void> {
  const idx = await load();
  if (idx.entries[id]) {
    delete idx.entries[id];
    await persistDebounced();
  }
}

export type SearchResult = {
  id: string;
  kind: IndexKind;
  title: string;
  snippet: string;
  score: number;
  metadata?: Record<string, unknown>;
};

export async function search(
  query: string,
  opts: { kind?: IndexKind; limit?: number } = {},
): Promise<SearchResult[]> {
  const limit = opts.limit ?? 5;
  const idx = await load();
  const q = await embed(query, 'RETRIEVAL_QUERY');
  const results: SearchResult[] = [];
  for (const e of Object.values(idx.entries)) {
    if (opts.kind && e.kind !== opts.kind) continue;
    results.push({
      id: e.id,
      kind: e.kind,
      title: e.title,
      snippet: e.snippet,
      score: dot(q, e.vector),
      metadata: e.metadata,
    });
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

// ===== Bulk indexers =====

function buildMemoryText(name: string, type: string, description: string, content: string): string {
  // Prefixa metadata pra a busca pegar nome/tipo também
  return `[${type}] ${name}: ${description}\n\n${content}`;
}

export async function reindexMemoryVault(
  vault: MemoryVault,
): Promise<{ embedded: number; skipped: number; removed: number }> {
  const idx = await load();
  const allEntries = vault.list?.() ?? [];
  // Fallback caso vault.list não exista — usa o graph().
  let memEntries: Array<{
    name: string;
    type: string;
    description: string;
    content: string;
  }> = [];
  if (Array.isArray(allEntries) && allEntries.length > 0) {
    memEntries = allEntries as typeof memEntries;
  } else {
    // Lê arquivos diretamente.
    const dir = join(homedir(), 'pixxel', 'memory');
    try {
      const files = await fs.readdir(dir);
      for (const f of files) {
        if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
        try {
          const raw = await fs.readFile(join(dir, f), 'utf-8');
          const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
          if (!m) continue;
          const fm = m[1];
          const body = m[2].trim();
          const get = (k: string) => {
            const r = fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
            return r ? r[1].trim().replace(/^["']|["']$/g, '') : '';
          };
          memEntries.push({
            name: get('name'),
            type: get('type'),
            description: get('description'),
            content: body,
          });
        } catch {
          /* skip */
        }
      }
    } catch {
      /* sem dir */
    }
  }

  let embedded = 0;
  let skipped = 0;
  const seenIds = new Set<string>();
  for (const e of memEntries) {
    if (!e.name) continue;
    const id = `memory:${e.name}`;
    seenIds.add(id);
    try {
      const r = await indexEntry({
        id,
        kind: 'memory',
        title: e.name,
        text: buildMemoryText(e.name, e.type, e.description, e.content),
        metadata: { type: e.type, description: e.description },
      });
      if (r.embedded) embedded++;
      else skipped++;
    } catch (err) {
      console.warn(`[embeddings] reindex memory ${e.name} falhou:`, err);
    }
  }
  // Remove entradas que não existem mais
  let removed = 0;
  for (const id of Object.keys(idx.entries)) {
    if (idx.entries[id].kind === 'memory' && !seenIds.has(id)) {
      delete idx.entries[id];
      removed++;
    }
  }
  if (removed > 0) await persistDebounced();
  return { embedded, skipped, removed };
}

export async function reindexWorklogs(): Promise<{
  embedded: number;
  skipped: number;
  removed: number;
}> {
  const idx = await load();
  let files: string[] = [];
  try {
    files = (await fs.readdir(WORKLOG_DIR)).filter((f) => f.endsWith('.md'));
  } catch {
    return { embedded: 0, skipped: 0, removed: 0 };
  }
  let embedded = 0;
  let skipped = 0;
  const seenIds = new Set<string>();
  for (const f of files) {
    const id = `worklog:${f}`;
    seenIds.add(id);
    try {
      const raw = await fs.readFile(join(WORKLOG_DIR, f), 'utf-8');
      // Trunca pra evitar estourar limites do embed.
      const text = raw.slice(0, 8000);
      // Extrai task/project do frontmatter pra title legível.
      const fm = raw.match(/^---\n([\s\S]*?)\n---/);
      let title = f;
      let project: string | undefined;
      let task: string | undefined;
      if (fm) {
        const get = (k: string) => {
          const r = fm[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
          return r ? r[1].trim().replace(/^["']|["']$/g, '') : undefined;
        };
        project = get('project');
        task = get('task');
        if (task) title = task.slice(0, 80);
      }
      const r = await indexEntry({
        id,
        kind: 'worklog',
        title,
        text,
        metadata: { filename: f, project, task },
      });
      if (r.embedded) embedded++;
      else skipped++;
    } catch (err) {
      console.warn(`[embeddings] reindex worklog ${f} falhou:`, err);
    }
  }
  let removed = 0;
  for (const id of Object.keys(idx.entries)) {
    if (idx.entries[id].kind === 'worklog' && !seenIds.has(id)) {
      delete idx.entries[id];
      removed++;
    }
  }
  if (removed > 0) await persistDebounced();
  return { embedded, skipped, removed };
}

/**
 * Roda em background no startup. Reindex incremental (skip se hash bate).
 * Sem await — o app não trava.
 */
export function initializeEmbeddings(vault: MemoryVault | null): void {
  if (!process.env.GEMINI_API_KEY) {
    console.log('[embeddings] GEMINI_API_KEY ausente — busca semântica desativada');
    return;
  }
  void (async () => {
    try {
      const t0 = Date.now();
      const memRes = vault
        ? await reindexMemoryVault(vault)
        : { embedded: 0, skipped: 0, removed: 0 };
      const wlRes = await reindexWorklogs();
      console.log(
        `[embeddings] index pronto em ${Date.now() - t0}ms — memory: +${memRes.embedded}/=${memRes.skipped}/-${memRes.removed} worklog: +${wlRes.embedded}/=${wlRes.skipped}/-${wlRes.removed}`,
      );
    } catch (err) {
      console.warn('[embeddings] init falhou:', err);
    }
  })();
}

/** Helper pra hooks: indexa 1 memory entry após write. */
export async function indexMemoryEntry(e: {
  name: string;
  type: string;
  description: string;
  content: string;
}): Promise<void> {
  if (!process.env.GEMINI_API_KEY) return;
  try {
    await indexEntry({
      id: `memory:${e.name}`,
      kind: 'memory',
      title: e.name,
      text: buildMemoryText(e.name, e.type, e.description, e.content),
      metadata: { type: e.type, description: e.description },
    });
  } catch (err) {
    console.warn('[embeddings] indexMemoryEntry falhou:', err);
  }
}

/** Helper pra hooks: remove uma memory entry do índice. */
export async function unindexMemoryEntry(name: string): Promise<void> {
  await removeEntry(`memory:${name}`);
}

/** Helper pra hook do work-log endSession. */
export async function indexWorklogFile(filename: string): Promise<void> {
  if (!process.env.GEMINI_API_KEY) return;
  try {
    const raw = await fs.readFile(join(WORKLOG_DIR, filename), 'utf-8');
    const text = raw.slice(0, 8000);
    const fm = raw.match(/^---\n([\s\S]*?)\n---/);
    let title = filename;
    let project: string | undefined;
    let task: string | undefined;
    if (fm) {
      const get = (k: string) => {
        const r = fm[1].match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
        return r ? r[1].trim().replace(/^["']|["']$/g, '') : undefined;
      };
      project = get('project');
      task = get('task');
      if (task) title = task.slice(0, 80);
    }
    await indexEntry({
      id: `worklog:${filename}`,
      kind: 'worklog',
      title,
      text,
      metadata: { filename, project, task },
    });
  } catch (err) {
    console.warn(`[embeddings] indexWorklogFile ${filename} falhou:`, err);
  }
}
