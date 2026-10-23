// Leitura do work-log persistente (~/pixxel/work-log/*.md). Read-only:
// duas operações expostas ao Gemini Live — listar últimas N sessões e ler
// uma específica pra resumir/falar.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPath } from '../data-dir.js';

const WORK_LOG_DIR = dataPath('work-log');

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
// Truncamos o conteúdo lido pra não estourar o contexto do Gemini —
// frontmatter + progresso + resultado de uma sessão típica cabem nisso.
const READ_MAX_CHARS = 8000;

type WorkLogMeta = {
  filename: string;
  date: string | null;
  project: string | null;
  task: string | null;
  status: string | null;
  source: string | null;
};

function parseFrontmatter(raw: string): Record<string, string> {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let val = line.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    out[key] = val.replace(/\\"/g, '"');
  }
  return out;
}

async function readMeta(filename: string): Promise<WorkLogMeta> {
  const full = join(WORK_LOG_DIR, filename);
  // Lê só o suficiente pra pegar o frontmatter.
  let head = '';
  try {
    const raw = await readFile(full, 'utf8');
    head = raw.slice(0, 600);
  } catch {
    // ignora — devolve meta com nulls
  }
  const fm = parseFrontmatter(head);
  return {
    filename,
    date: fm.date ?? null,
    project: fm.project ?? null,
    task: fm.task ?? null,
    status: fm.status ?? null,
    source: fm.source ?? null,
  };
}

export async function listWorkLogs(limit: number): Promise<{
  ok: true;
  text: string;
  entries: WorkLogMeta[];
} | { ok: false; reason: string }> {
  const cap = Math.min(Math.max(1, Math.floor(limit) || DEFAULT_LIMIT), MAX_LIMIT);
  let names: string[];
  try {
    names = (await readdir(WORK_LOG_DIR)).filter((n) => n.endsWith('.md'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: true, text: 'Nenhum work-log salvo ainda.', entries: [] };
    }
    return { ok: false, reason: err instanceof Error ? err.message : 'readdir falhou' };
  }
  if (names.length === 0) {
    return { ok: true, text: 'Nenhum work-log salvo ainda.', entries: [] };
  }
  // Ordena por mtime desc — mais recente primeiro.
  const stamped = await Promise.all(
    names.map(async (n) => {
      try {
        const s = await stat(join(WORK_LOG_DIR, n));
        return { n, mtime: s.mtimeMs };
      } catch {
        return { n, mtime: 0 };
      }
    }),
  );
  stamped.sort((a, b) => b.mtime - a.mtime);
  const top = stamped.slice(0, cap);
  const entries = await Promise.all(top.map((s) => readMeta(s.n)));

  const lines = entries.map((e, i) => {
    const proj = e.project ?? '?';
    const task = e.task ?? '(sem título)';
    const status =
      e.status === 'done' ? '✅' : e.status === 'error' ? '❌' : '⏳';
    const when = e.date ? new Date(e.date).toLocaleString('pt-BR') : '?';
    return `${i + 1}. ${status} ${proj} — ${task}  _(${when})_`;
  });
  const text = `Últimas ${entries.length} sessões de trabalho:\n${lines.join('\n')}`;
  return { ok: true, text, entries };
}

export async function readWorkLog(query: string): Promise<{
  ok: true;
  text: string;
  filename: string;
} | { ok: false; reason: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return { ok: false, reason: 'query vazia' };

  let names: string[];
  try {
    names = (await readdir(WORK_LOG_DIR)).filter((n) => n.endsWith('.md'));
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'readdir falhou' };
  }
  if (names.length === 0) return { ok: false, reason: 'nenhum work-log salvo' };

  // Match: nome exato → filename contém query → palavras da query no filename.
  const exact = names.find((n) => n === q || n === `${q}.md`);
  let chosen: string | undefined = exact;
  if (!chosen) chosen = names.find((n) => n.toLowerCase().includes(q));
  if (!chosen) {
    const tokens = q.split(/\s+/).filter((t) => t.length > 2);
    if (tokens.length > 0) {
      const stamped = await Promise.all(
        names.map(async (n) => {
          const s = await stat(join(WORK_LOG_DIR, n)).catch(() => null);
          const score = tokens.reduce(
            (acc, t) => acc + (n.toLowerCase().includes(t) ? 1 : 0),
            0,
          );
          return { n, score, mtime: s?.mtimeMs ?? 0 };
        }),
      );
      stamped.sort((a, b) => b.score - a.score || b.mtime - a.mtime);
      if (stamped[0]?.score > 0) chosen = stamped[0].n;
    }
  }

  if (!chosen) return { ok: false, reason: `nenhuma sessão bate com "${query}"` };

  let raw: string;
  try {
    raw = await readFile(join(WORK_LOG_DIR, chosen), 'utf8');
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : 'readFile falhou' };
  }

  const text =
    raw.length > READ_MAX_CHARS
      ? raw.slice(0, READ_MAX_CHARS) + '\n\n…[truncado, abre o arquivo pra ver completo]'
      : raw;
  return { ok: true, text, filename: chosen };
}
