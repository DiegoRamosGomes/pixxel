// Corpus rotulado de emails (importante / não-importante) com embedding.
// JSONL em ~/pixxel/email-labels.jsonl — uma linha por exemplo. Apêndice
// contínuo, sem reescrita do arquivo.
//
// Cada linha:
//   { id, label: 'important'|'not', from, subject, snippet, vector, addedAt }

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../../data-dir.js';

const FILE = dataPath('email-labels.jsonl');

export type LabelExample = {
  id: string;
  label: 'important' | 'not';
  from: string;
  subject: string;
  snippet: string;
  vector: number[];
  addedAt: string;
};

let cache: LabelExample[] | null = null;

async function ensureDir(): Promise<void> {
  const dir = FILE.replace(/\/[^/]+$/, '');
  await fs.mkdir(dir, { recursive: true });
}

export async function loadLabels(): Promise<LabelExample[]> {
  if (cache) return cache;
  try {
    const buf = await fs.readFile(FILE, 'utf8');
    const out: LabelExample[] = [];
    for (const line of buf.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as LabelExample);
      } catch {
        // ignora linha corrompida
      }
    }
    cache = out;
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'ENOENT') {
      cache = [];
    } else {
      throw err;
    }
  }
  return cache;
}

export async function appendLabel(ex: LabelExample): Promise<void> {
  await ensureDir();
  await fs.appendFile(FILE, JSON.stringify(ex) + '\n', 'utf8');
  if (cache) cache.push(ex);
  else cache = [ex];
}

export async function removeLabel(id: string): Promise<boolean> {
  const all = await loadLabels();
  const next = all.filter((e) => e.id !== id);
  if (next.length === all.length) return false;
  await ensureDir();
  await fs.writeFile(
    FILE,
    next.map((e) => JSON.stringify(e)).join('\n') + (next.length ? '\n' : ''),
    'utf8',
  );
  cache = next;
  return true;
}

export function labelStats(items: LabelExample[]): {
  total: number;
  important: number;
  not: number;
} {
  let important = 0;
  let not = 0;
  for (const e of items) {
    if (e.label === 'important') important++;
    else not++;
  }
  return { total: items.length, important, not };
}
