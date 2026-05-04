// Vault de memória persistente em markdown — vive em ~/pixxel/memory/.
// Compatível com Obsidian (frontmatter + wikilinks). Cada entrada é um .md
// próprio; MEMORY.md é só índice (uma linha por entrada).
//
// Tipos:
//   user       — perfil/gostos/profissão/contexto pessoal
//   feedback   — correções e validações de comportamento (com Why + How)
//   project    — decisões/estado de iniciativas (com Why + How)
//   reference  — ponteiros pra sistemas externos
//
// O system prompt do Gemini Live recebe sempre: índice completo + corpo das
// entradas user/feedback (que quase sempre importam). project/reference vão
// só no índice — Gemini puxa sob demanda se precisar (fase 2: search_memory).

import { app } from 'electron';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference';

export interface MemoryEntry {
  name: string;          // slug usado como nome de arquivo, ex: "user_role"
  type: MemoryType;
  description: string;   // uma linha — vai pro índice
  content: string;       // corpo markdown da entrada
  links: string[];       // outros names referenciados via [[wikilinks]]
}

const VALID_NAME = /^[a-z0-9][a-z0-9_-]{0,60}$/;
const MAX_DESC = 200;
const MAX_CONTENT = 4000;
const MAX_ENTRIES = 500;

function vaultDir(): string {
  return join(homedir(), 'pixxel', 'memory');
}

function entryPath(dir: string, name: string): string {
  return join(dir, `${name}.md`);
}

function indexPath(dir: string): string {
  return join(dir, 'MEMORY.md');
}

function escapeYaml(s: string): string {
  return s.replace(/"/g, '\\"');
}

function serialize(e: MemoryEntry): string {
  const linksLine = e.links.length
    ? `\n\nRelacionado: ${e.links.map((l) => `[[${l}]]`).join(' ')}`
    : '';
  return [
    '---',
    `name: ${e.name}`,
    `type: ${e.type}`,
    `description: "${escapeYaml(e.description)}"`,
    e.links.length ? `links: [${e.links.map((l) => `"${l}"`).join(', ')}]` : 'links: []',
    '---',
    '',
    e.content.trim() + linksLine,
    '',
  ].join('\n');
}

function parseFrontmatter(raw: string): MemoryEntry | null {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fm = m[1];
  const body = m[2].trim();
  const get = (k: string) => {
    const r = fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
    return r ? r[1].trim() : '';
  };
  const name = get('name').replace(/^["']|["']$/g, '');
  const type = get('type').replace(/^["']|["']$/g, '') as MemoryType;
  const description = get('description').replace(/^["']|["']$/g, '').replace(/\\"/g, '"');
  const linksRaw = get('links');
  let links: string[] = [];
  if (linksRaw && linksRaw !== '[]') {
    links = (linksRaw.match(/"([^"]+)"/g) ?? []).map((s) => s.replace(/"/g, ''));
  }
  if (!name || !['user', 'feedback', 'project', 'reference'].includes(type)) return null;
  // Remove a "Relacionado: [[...]]" linha do conteúdo se presente — ela é
  // derivada de `links` e regenerada no save.
  const content = body.replace(/\n*Relacionado:\s*(\[\[[^\]]+\]\]\s*)+\s*$/m, '').trim();
  return { name, type, description, content, links };
}

function indexLine(e: MemoryEntry): string {
  return `- [${e.name}](${e.name}.md) — ${e.description}`;
}

export class MemoryVault {
  private entries = new Map<string, MemoryEntry>();
  private dir: string;
  private loaded = false;

  constructor(dir = vaultDir()) {
    this.dir = dir;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.dir, { recursive: true });
    await this.migrateLegacyJson();
    let files: string[] = [];
    try {
      files = await readdir(this.dir);
    } catch (err) {
      console.warn('[memory] readdir falhou:', err);
    }
    for (const f of files) {
      if (!f.endsWith('.md') || f === 'MEMORY.md') continue;
      try {
        const raw = await readFile(join(this.dir, f), 'utf8');
        const parsed = parseFrontmatter(raw);
        if (parsed) this.entries.set(parsed.name, parsed);
      } catch (err) {
        console.warn(`[memory] falha ao ler ${f}:`, err);
      }
    }
    console.log(`[memory] vault carregado (${this.entries.size} entradas) em ${this.dir}`);
    this.loaded = true;
  }

  /** Migra o memory.json antigo (lista flat de fatos) pra entradas user_*.md. */
  private async migrateLegacyJson(): Promise<void> {
    try {
      const legacy = join(app.getPath('userData'), 'memory.json');
      if (!existsSync(legacy)) return;
      const raw = await readFile(legacy, 'utf8');
      const parsed = JSON.parse(raw) as { facts?: string[] };
      const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
      if (facts.length === 0) {
        await rename(legacy, legacy + '.migrated');
        return;
      }
      const target = join(this.dir, 'user_legacy_facts.md');
      if (!existsSync(target)) {
        const e: MemoryEntry = {
          name: 'user_legacy_facts',
          type: 'user',
          description: 'Fatos migrados da versão antiga (lista flat).',
          content: facts.map((f) => `- ${f}`).join('\n'),
          links: [],
        };
        await writeFile(target, serialize(e), 'utf8');
        console.log(`[memory] migrados ${facts.length} fato(s) do JSON legacy`);
      }
      await rename(legacy, legacy + '.migrated');
    } catch (err) {
      console.warn('[memory] migração legacy falhou:', err);
    }
  }

  /**
   * Estrutura serializável pro grafo do renderer. Nodes = entradas; edges =
   * wikilinks (apenas se ambas as pontas existirem). Nó também conecta com um
   * "type-hub" sintético (user/feedback/project/reference) pra agrupar visualmente.
   */
  graph(): {
    nodes: Array<{ id: string; label: string; type: MemoryType | 'hub'; description?: string }>;
    edges: Array<{ source: string; target: string; kind: 'link' | 'type' }>;
  } {
    const nodes: Array<{ id: string; label: string; type: MemoryType | 'hub'; description?: string }> = [];
    const edges: Array<{ source: string; target: string; kind: 'link' | 'type' }> = [];
    const hubs: MemoryType[] = ['user', 'feedback', 'project', 'reference'];
    for (const t of hubs) {
      nodes.push({ id: `__hub_${t}`, label: t, type: 'hub' });
    }
    for (const e of this.entries.values()) {
      nodes.push({ id: e.name, label: e.name, type: e.type, description: e.description });
      edges.push({ source: `__hub_${e.type}`, target: e.name, kind: 'type' });
      for (const l of e.links) {
        if (this.entries.has(l)) {
          edges.push({ source: e.name, target: l, kind: 'link' });
        }
      }
    }
    return { nodes, edges };
  }

  list(type?: MemoryType): MemoryEntry[] {
    const all = [...this.entries.values()];
    return type ? all.filter((e) => e.type === type) : all;
  }

  get(name: string): MemoryEntry | undefined {
    return this.entries.get(name);
  }

  async remember(input: {
    name: string;
    type: MemoryType;
    description: string;
    content: string;
    links?: string[];
  }): Promise<{ ok: boolean; reason?: string }> {
    const name = input.name.trim().toLowerCase();
    if (!VALID_NAME.test(name)) {
      return { ok: false, reason: 'name inválido (use [a-z0-9_-], 1-60 chars)' };
    }
    if (!['user', 'feedback', 'project', 'reference'].includes(input.type)) {
      return { ok: false, reason: 'type inválido' };
    }
    const description = input.description.trim();
    const content = input.content.trim();
    if (!description) return { ok: false, reason: 'description vazia' };
    if (!content) return { ok: false, reason: 'content vazio' };
    if (description.length > MAX_DESC) return { ok: false, reason: `description > ${MAX_DESC} chars` };
    if (content.length > MAX_CONTENT) return { ok: false, reason: `content > ${MAX_CONTENT} chars` };
    if (this.entries.has(name)) {
      return { ok: false, reason: `entrada "${name}" já existe — use update_memory` };
    }
    if (this.entries.size >= MAX_ENTRIES) {
      return { ok: false, reason: `limite de ${MAX_ENTRIES} entradas atingido` };
    }
    const links = (input.links ?? []).map((l) => l.trim().toLowerCase()).filter(Boolean);
    const entry: MemoryEntry = { name, type: input.type, description, content, links };
    this.entries.set(name, entry);
    await this.persist(entry);
    await this.writeIndex();
    return { ok: true };
  }

  async update(input: {
    name: string;
    description?: string;
    content?: string;
    links?: string[];
  }): Promise<{ ok: boolean; reason?: string }> {
    const name = input.name.trim().toLowerCase();
    const existing = this.entries.get(name);
    if (!existing) return { ok: false, reason: `entrada "${name}" não existe` };
    const next: MemoryEntry = { ...existing };
    if (input.description !== undefined) {
      const d = input.description.trim();
      if (!d) return { ok: false, reason: 'description vazia' };
      if (d.length > MAX_DESC) return { ok: false, reason: `description > ${MAX_DESC} chars` };
      next.description = d;
    }
    if (input.content !== undefined) {
      const c = input.content.trim();
      if (!c) return { ok: false, reason: 'content vazio' };
      if (c.length > MAX_CONTENT) return { ok: false, reason: `content > ${MAX_CONTENT} chars` };
      next.content = c;
    }
    if (input.links !== undefined) {
      next.links = input.links.map((l) => l.trim().toLowerCase()).filter(Boolean);
    }
    this.entries.set(name, next);
    await this.persist(next);
    await this.writeIndex();
    return { ok: true };
  }

  async forget(name: string): Promise<{ ok: boolean; reason?: string }> {
    const n = name.trim().toLowerCase();
    if (!this.entries.has(n)) return { ok: false, reason: `entrada "${n}" não existe` };
    this.entries.delete(n);
    try {
      await rm(entryPath(this.dir, n));
    } catch (err) {
      console.warn(`[memory] rm ${n} falhou:`, err);
    }
    await this.writeIndex();
    return { ok: true };
  }

  /**
   * Bloco a injetar no system instruction do Gemini Live.
   * Inclui índice completo + corpo das entradas user/feedback (sempre úteis).
   * Entradas project/reference só aparecem no índice (puxadas sob demanda).
   */
  formatForPrompt(): string {
    if (this.entries.size === 0) return '';
    const all = [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    const indexLines = all.map((e) => `- ${e.name} (${e.type}) — ${e.description}`).join('\n');
    const bodies = all
      .filter((e) => e.type === 'user' || e.type === 'feedback')
      .map((e) => `### ${e.name}\n${e.content}`)
      .join('\n\n');
    return [
      '\n\nMEMÓRIA PERSISTENTE SOBRE O USUÁRIO E O TRABALHO (vault em ~/pixxel/memory/):',
      '',
      'Índice completo:',
      indexLines,
      bodies ? '\n\nDetalhe das entradas user/feedback (já carregadas):\n\n' + bodies : '',
    ].join('\n');
  }

  private async persist(e: MemoryEntry): Promise<void> {
    const path = entryPath(this.dir, e.name);
    const tmp = path + '.tmp';
    await writeFile(tmp, serialize(e), 'utf8');
    await rename(tmp, path);
  }

  private async writeIndex(): Promise<void> {
    const all = [...this.entries.values()].sort((a, b) => a.name.localeCompare(b.name));
    const grouped: Record<MemoryType, MemoryEntry[]> = {
      user: [],
      feedback: [],
      project: [],
      reference: [],
    };
    for (const e of all) grouped[e.type].push(e);
    const sections: string[] = ['# Memória do Pixxel', ''];
    const labels: Record<MemoryType, string> = {
      user: 'Usuário',
      feedback: 'Feedback',
      project: 'Projetos',
      reference: 'Referências',
    };
    for (const t of ['user', 'feedback', 'project', 'reference'] as MemoryType[]) {
      if (grouped[t].length === 0) continue;
      sections.push(`## ${labels[t]}`);
      for (const e of grouped[t]) sections.push(indexLine(e));
      sections.push('');
    }
    const path = indexPath(this.dir);
    const tmp = path + '.tmp';
    await writeFile(tmp, sections.join('\n'), 'utf8');
    await rename(tmp, path);
  }
}
