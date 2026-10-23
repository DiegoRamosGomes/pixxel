// Busca de projetos por nome aproximado e abertura no VSCode.
//
// Configuração: env `PROJECTS_ROOTS` com caminhos separados por vírgula.
// Default: $HOME/Projects e $HOME/projetos (os que existirem).
//
// Estratégia: scan depth-2 nos roots, tokeniza nome do projeto e query,
// pontua por interseção de tokens. Match >= 50% abre direto. Senão devolve
// alternativas pro Gemini perguntar ao usuário.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const SCAN_DEPTH = 2;

// Tokens irrelevantes em pt-BR que aparecem em pedidos de "abre projeto X"
const STOPWORDS = new Set([
  'o',
  'a',
  'os',
  'as',
  'da',
  'do',
  'de',
  'no',
  'na',
  'em',
  'um',
  'uma',
  'pra',
  'para',
  'projeto',
  'pasta',
  'repo',
  'repositorio',
  'abre',
  'abra',
  'abrir',
  'open',
  'project',
  'folder',
]);

export type Project = { name: string; path: string; root: string };

function getRoots(): string[] {
  const env = process.env.PROJECTS_ROOTS;
  if (env) {
    return env
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Linux usa ~/Projects; no Mac do Diego os projetos ficam em ~/projetos.
  return [join(homedir(), 'Projects'), join(homedir(), 'projetos')].filter((d) => existsSync(d));
}

function scan(
  dir: string,
  depth: number,
  rootBase: string,
  out: Project[],
): void {
  if (depth === 0) return;
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.startsWith('.') || e === 'node_modules') continue;
    const full = join(dir, e);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;

    const rel = full.startsWith(rootBase + '/')
      ? full.slice(rootBase.length + 1)
      : e;
    out.push({ name: rel, path: full, root: rootBase });

    if (depth > 1) scan(full, depth - 1, rootBase, out);
  }
}

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s/-]/gu, ' ')
    .split(/[\s/-]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

function scoreProject(qTokens: string[], project: Project): number {
  if (qTokens.length === 0) return 0;
  const pTokens = tokenize(project.name);
  let hits = 0;
  for (const q of qTokens) {
    if (pTokens.some((p) => p === q || p.includes(q) || q.includes(p))) {
      hits += 1;
    }
  }
  return hits / qTokens.length;
}

export function listProjects(): Project[] {
  const roots = getRoots();
  const out: Project[] = [];
  for (const r of roots) scan(r, SCAN_DEPTH, r, out);
  return out;
}

export type OpenProjectResult =
  | { ok: true; text: string; project: Project }
  | {
      ok: false;
      reason: string;
      alternatives?: Array<{ name: string; path: string }>;
    };

export type FindProjectResult =
  | { ok: true; project: Project }
  | {
      ok: false;
      reason: string;
      alternatives?: Array<{ name: string; path: string }>;
    };

/**
 * Match fuzzy igual ao openProject mas SEM abrir VSCode. Usado quando só
 * precisamos resolver o path do projeto, sem efeitos visuais externos.
 */
export function findProject(query: string): FindProjectResult {
  const all = listProjects();
  if (all.length === 0) {
    return {
      ok: false,
      reason: `Nenhum projeto encontrado nos roots ${getRoots().join(', ')}. Configure PROJECTS_ROOTS no .env.`,
    };
  }
  const qTokens = tokenize(query);
  if (qTokens.length === 0) {
    return { ok: false, reason: 'query muito vaga depois de remover stopwords' };
  }
  const ranked = all
    .map((p) => ({ p, s: scoreProject(qTokens, p) }))
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s;
      return b.p.name.split('/').length - a.p.name.split('/').length;
    });
  const best = ranked[0];
  if (!best || best.s < 0.5) {
    return {
      ok: false,
      reason: `Não encontrei projeto bom pra "${query}".`,
      alternatives: ranked.slice(0, 8).map(({ p }) => ({ name: p.name, path: p.path })),
    };
  }
  return { ok: true, project: best.p };
}

export async function openProject(query: string): Promise<OpenProjectResult> {
  const found = findProject(query);
  if (!found.ok) return found;

  // Abre no VSCode (binário `code`)
  return new Promise<OpenProjectResult>((resolve) => {
    const child = spawn('code', [found.project.path], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', (err) => {
      const msg = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'binário `code` não encontrado no PATH. Instale a extensão "Shell Command: Install" do VSCode.'
        : err.message;
      resolve({ ok: false, reason: msg });
    });
    child.on('spawn', () => {
      child.unref();
      resolve({
        ok: true,
        text: `Abrindo ${found.project.name}.`,
        project: found.project,
      });
    });
  });
}
