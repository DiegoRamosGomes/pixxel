import type { MemoryVault, MemoryEntry } from '../memory.js';

/**
 * Constrói o texto que vai pro `--append-system-prompt` do `claude` CLI,
 * baseado na MemoryVault do Pixxel. Inclui:
 *
 * - Todas entradas `user_*` (perfil do usuário, sempre relevante)
 * - Feedbacks globais (commit style, no_coauthor, response_tone, etc)
 * - Feedbacks project-scoped relevantes ao cwd atual
 * - Entradas `project_*` relevantes ao cwd
 *
 * O Claude já tem auto-memory dele próprio carregada (`~/.claude/projects/...
 * /memory/`). Esse append do Pixxel complementa com a memória do assistente.
 */

interface ScopeRule {
  /** Nome da entrada precisa conter UM destes keywords pra ser considerada do scope. */
  nameKeywords: string[];
  /** Cwd precisa conter UM destes paths pra entrada ser incluída. */
  cwdPaths: string[];
}

const PROJECT_SCOPES: ScopeRule[] = [
  { nameKeywords: ['pixxel', 'assistant'], cwdPaths: ['/dk/assistant', '/pixxel'] },
  { nameKeywords: ['girolabs', 'easytax'], cwdPaths: ['/girolabs/'] },
  { nameKeywords: ['aquarela'], cwdPaths: ['/aquarela'] },
  { nameKeywords: ['echords', 'e-chords'], cwdPaths: ['/echords', '/e-chords'] },
  { nameKeywords: ['dktv'], cwdPaths: ['/dktv'] },
];

const MAX_TOTAL_CHARS = 6000;
const MAX_PER_ENTRY_CHARS = 600;

export function buildAppendSystemPrompt(memory: MemoryVault, cwd: string): string {
  const all = memory.list();
  const user = all.filter((e) => e.type === 'user');
  const feedback = all.filter((e) => e.type === 'feedback');
  const project = all.filter((e) => e.type === 'project');

  const relevantFeedback = feedback.filter((e) => entryAppliesToCwd(e.name, cwd));
  const relevantProject = project.filter((e) => entryAppliesToCwd(e.name, cwd));

  const sections: string[] = [];

  sections.push(
    '## Contexto fornecido pelo Pixxel (assistente do Diego)\n' +
      'O Pixxel mantém memória persistente sobre o Diego e seus padrões. ' +
      'Considere isto como instruções de alta prioridade vindas do usuário.\n',
  );

  if (user.length > 0) {
    sections.push('### Sobre o usuário (Diego)\n' + formatEntries(user));
  }
  if (relevantFeedback.length > 0) {
    sections.push('### Preferências e padrões relevantes a este projeto\n' + formatEntries(relevantFeedback));
  }
  if (relevantProject.length > 0) {
    sections.push('### Contexto de projetos relevantes\n' + formatEntries(relevantProject));
  }

  let text = sections.join('\n');
  if (text.length > MAX_TOTAL_CHARS) {
    text = text.slice(0, MAX_TOTAL_CHARS) + '\n…(truncado)';
  }
  return text;
}

function entryAppliesToCwd(name: string, cwd: string): boolean {
  const n = name.toLowerCase();
  const c = cwd.toLowerCase();
  for (const scope of PROJECT_SCOPES) {
    const nameMatches = scope.nameKeywords.some((k) => n.includes(k));
    if (nameMatches) {
      // Entrada é project-scoped → só inclui se cwd bater
      return scope.cwdPaths.some((p) => c.includes(p));
    }
  }
  // Nome não bateu nenhum scope conhecido → considera global (sempre inclui)
  return true;
}

function formatEntries(entries: MemoryEntry[]): string {
  return entries
    .map((e) => {
      const body = e.content.trim();
      const truncated = body.length > MAX_PER_ENTRY_CHARS
        ? body.slice(0, MAX_PER_ENTRY_CHARS) + '…'
        : body;
      return `**${e.name}** — ${e.description}\n${truncated}`;
    })
    .join('\n\n');
}
