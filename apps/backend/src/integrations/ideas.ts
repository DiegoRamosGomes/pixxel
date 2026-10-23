import { promises as fs } from 'node:fs';
import { dataPath } from '../data-dir.js';

// Ideias capturadas por voz ficam na pasta de dados da API (não no repo).
const IDEAS_FILE = dataPath('IDEIAS.md');

const SECTION_HEADING = '## Capturadas via voz';

export type IdeaStatus = 'ideia' | 'planejado';

export type SaveIdeaInput = {
  title: string;
  description: string;
  /** Plano elaborado (Gemini). Quando presente, status vira "planejado". */
  plan?: string;
};

export type SaveIdeaResult = {
  ok: true;
  path: string;
  status: IdeaStatus;
  /** Anchor em markdown da entrada criada — útil pra editar depois. */
  anchor: string;
} | {
  ok: false;
  reason: string;
};

function todayIso(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

async function ensureSection(content: string): Promise<string> {
  if (content.includes(SECTION_HEADING)) return content;
  const sep = content.endsWith('\n') ? '\n' : '\n\n';
  return `${content}${sep}---\n\n${SECTION_HEADING}\n\nIdeias capturadas em conversa por voz com o Pixxel.\n`;
}

export async function saveIdea(input: SaveIdeaInput): Promise<SaveIdeaResult> {
  const title = input.title.trim();
  const description = input.description.trim();
  if (!title) return { ok: false, reason: 'título vazio' };
  if (!description) return { ok: false, reason: 'descrição vazia' };

  const status: IdeaStatus = input.plan ? 'planejado' : 'ideia';
  const date = todayIso();
  const anchor = `${date}-${slugify(title)}`;

  let entry =
    `\n### ${title}\n` +
    `<!-- anchor: ${anchor} -->\n` +
    `- **Status:** ${status} (${date})\n` +
    `- **O quê:** ${description}\n`;

  if (input.plan) {
    entry += `\n#### Plano (Gemini)\n\n${input.plan.trim()}\n`;
  }

  try {
    let current = '';
    try {
      current = await fs.readFile(IDEAS_FILE, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      current = '# Ideias para versões futuras\n';
    }
    const withSection = await ensureSection(current);
    const next = withSection.endsWith('\n')
      ? `${withSection}${entry}`
      : `${withSection}\n${entry}`;
    await fs.writeFile(IDEAS_FILE, next, 'utf-8');
    return { ok: true, path: IDEAS_FILE, status, anchor };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'falhou ao escrever IDEIAS.md',
    };
  }
}

export const IDEAS_FILE_PATH = IDEAS_FILE;
