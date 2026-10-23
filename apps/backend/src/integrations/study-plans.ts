// Planos de estudo persistentes — vive em ~/pixxel/study-plans/.
// JSON é fonte da verdade; MD é renderizado pra leitura no Obsidian.
// Edição via tools (Gemini Live) — não edite o MD à mão.

import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { dataPath } from '../data-dir.js';

const PLANS_DIR = dataPath('study-plans');

export type TopicStatus = 'not-started' | 'in-progress' | 'done' | 'skipped';

export type StudyPlanTopic = {
  id: string;
  title: string;
  /** Url do vídeo YouTube atribuído (preenchido na 1ª vez que ela "estuda" o tópico). */
  videoUrl: string | null;
  videoTitle?: string | null;
  /** Histórico de vídeos já vistos/recusados pra esse tópico (evita repetir). */
  watchedVideos?: Array<{ url: string; title: string; addedAt: string }>;
  status: TopicStatus;
  /** Notas livres da pessoa estudando (acumula). */
  notes: string;
  /** Timestamps marcantes. */
  startedAt?: string;
  completedAt?: string;
};

export type StudyPlanModule = {
  id: string;
  title: string;
  objective: string;
  topics: StudyPlanTopic[];
};

export type StudyPlan = {
  planId: string;
  owner: string;
  topic: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'paused' | 'done' | 'archived';
  modules: StudyPlanModule[];
};

export type StudyPlanSummary = {
  planId: string;
  owner: string;
  topic: string;
  status: StudyPlan['status'];
  totalTopics: number;
  doneTopics: number;
  currentModule: string | null;
  currentTopic: string | null;
};

function planFile(planId: string, ext: 'json' | 'md'): string {
  return join(PLANS_DIR, `${planId}.${ext}`);
}

function nowIso(): string {
  return new Date().toISOString();
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

export class StudyPlanStore {
  private cache = new Map<string, StudyPlan>();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(PLANS_DIR, { recursive: true });
    let files: string[] = [];
    try {
      files = await readdir(PLANS_DIR);
    } catch (err) {
      console.warn('[study-plans] readdir falhou:', err);
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await readFile(join(PLANS_DIR, f), 'utf8');
        const plan = JSON.parse(raw) as StudyPlan;
        if (plan.planId) this.cache.set(plan.planId, plan);
      } catch (err) {
        console.warn(`[study-plans] falha ao ler ${f}:`, err);
      }
    }
    console.log(`[study-plans] carregados ${this.cache.size} plano(s) em ${PLANS_DIR}`);
    this.loaded = true;
  }

  list(): StudyPlanSummary[] {
    return [...this.cache.values()].map((p) => this.summarize(p));
  }

  get(planId: string): StudyPlan | null {
    return this.cache.get(planId) ?? null;
  }

  /**
   * Resolução flexível de plan_id. Cobre:
   * - slug exato
   * - substring em topic/owner
   * - vazio ou termo genérico ("meu", "minha", "atual", "o curso") → único
   *   plano ativo (ou o mais recente se houver vários)
   */
  resolve(query: string): StudyPlan | null {
    const q = (query ?? '').trim().toLowerCase();
    const isVague =
      !q ||
      q === 'meu' ||
      q === 'minha' ||
      q === 'meu curso' ||
      q === 'minha plano' ||
      q === 'meu plano' ||
      q === 'atual' ||
      q === 'o curso' ||
      q === 'esse' ||
      q === 'esse plano';
    if (isVague) {
      const active = [...this.cache.values()]
        .filter((p) => p.status === 'active')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return active[0] ?? null;
    }
    const exact = this.cache.get(q);
    if (exact) return exact;
    const norm = (s: string) =>
      s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const qn = norm(q);
    for (const p of this.cache.values()) {
      if (
        norm(p.planId).includes(qn) ||
        norm(p.topic).includes(qn) ||
        norm(p.owner).includes(qn)
      ) {
        return p;
      }
    }
    return null;
  }

  summarize(plan: StudyPlan): StudyPlanSummary {
    const allTopics = plan.modules.flatMap((m) => m.topics);
    const done = allTopics.filter((t) => t.status === 'done').length;
    const cur = this.findCurrent(plan);
    return {
      planId: plan.planId,
      owner: plan.owner,
      topic: plan.topic,
      status: plan.status,
      totalTopics: allTopics.length,
      doneTopics: done,
      currentModule: cur?.module.title ?? null,
      currentTopic: cur?.topic.title ?? null,
    };
  }

  /** Próximo tópico não feito (in-progress tem prioridade sobre not-started). */
  findCurrent(
    plan: StudyPlan,
  ): { module: StudyPlanModule; topic: StudyPlanTopic } | null {
    // Em-progresso primeiro
    for (const m of plan.modules) {
      const inProg = m.topics.find((t) => t.status === 'in-progress');
      if (inProg) return { module: m, topic: inProg };
    }
    // Depois o próximo não-começado
    for (const m of plan.modules) {
      const nb = m.topics.find((t) => t.status === 'not-started');
      if (nb) return { module: m, topic: nb };
    }
    return null;
  }

  findTopic(
    plan: StudyPlan,
    topicId: string,
  ): { module: StudyPlanModule; topic: StudyPlanTopic } | null {
    const tid = topicId.trim().toLowerCase();
    for (const m of plan.modules) {
      const t = m.topics.find(
        (t) => t.id.toLowerCase() === tid || slugify(t.title) === tid,
      );
      if (t) return { module: m, topic: t };
    }
    // Fallback: substring no título
    for (const m of plan.modules) {
      const t = m.topics.find((t) => t.title.toLowerCase().includes(tid));
      if (t) return { module: m, topic: t };
    }
    return null;
  }

  async create(input: {
    planId?: string;
    owner: string;
    topic: string;
    goal: string;
    modules: Array<{
      id?: string;
      title: string;
      objective: string;
      topics: Array<{ id?: string; title: string }>;
    }>;
  }): Promise<{ ok: boolean; reason?: string; plan?: StudyPlan }> {
    const owner = input.owner.trim();
    const topic = input.topic.trim();
    const goal = input.goal.trim();
    if (!owner || !topic || !goal) {
      return { ok: false, reason: 'owner, topic e goal são obrigatórios' };
    }
    if (input.modules.length === 0) {
      return { ok: false, reason: 'nenhum módulo no plano' };
    }
    const planId =
      (input.planId ? slugify(input.planId) : '') ||
      `${slugify(owner)}-${slugify(topic)}`;
    if (this.cache.has(planId)) {
      return { ok: false, reason: `plano "${planId}" já existe` };
    }
    const now = nowIso();
    const plan: StudyPlan = {
      planId,
      owner,
      topic,
      goal,
      createdAt: now,
      updatedAt: now,
      status: 'active',
      modules: input.modules.map((m, mi) => ({
        id: m.id ? slugify(m.id) : `m${mi + 1}-${slugify(m.title)}`,
        title: m.title.trim(),
        objective: m.objective.trim(),
        topics: m.topics.map((t, ti) => ({
          id: t.id ? slugify(t.id) : `${mi + 1}-${ti + 1}-${slugify(t.title)}`,
          title: t.title.trim(),
          videoUrl: null,
          videoTitle: null,
          status: 'not-started' as const,
          notes: '',
        })),
      })),
    };
    this.cache.set(planId, plan);
    await this.persist(plan);
    return { ok: true, plan };
  }

  async markTopic(
    planId: string,
    topicId: string,
    status: TopicStatus,
    note?: string,
  ): Promise<{ ok: boolean; reason?: string; topic?: StudyPlanTopic }> {
    const plan = this.cache.get(planId);
    if (!plan) return { ok: false, reason: `plano "${planId}" não existe` };
    const found = this.findTopic(plan, topicId);
    if (!found) return { ok: false, reason: `tópico "${topicId}" não existe` };
    const t = found.topic;
    const prev = t.status;
    t.status = status;
    if (status === 'in-progress' && !t.startedAt) t.startedAt = nowIso();
    if (status === 'done') t.completedAt = nowIso();
    if (note && note.trim()) {
      const stamp = new Date().toISOString().slice(0, 10);
      t.notes = (t.notes ? t.notes + '\n' : '') + `- (${stamp}) ${note.trim()}`;
    }
    plan.updatedAt = nowIso();
    // Se concluiu o último tópico, marca plano como done
    const allDone = plan.modules
      .flatMap((m) => m.topics)
      .every((tp) => tp.status === 'done' || tp.status === 'skipped');
    if (allDone) plan.status = 'done';
    await this.persist(plan);
    console.log(
      `[study-plans] ${planId}: ${t.title} ${prev} → ${status}` +
        (note ? ` (com nota)` : ''),
    );
    return { ok: true, topic: t };
  }

  async setTopicVideo(
    planId: string,
    topicId: string,
    videoUrl: string,
    videoTitle?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const plan = this.cache.get(planId);
    if (!plan) return { ok: false, reason: `plano "${planId}" não existe` };
    const found = this.findTopic(plan, topicId);
    if (!found) return { ok: false, reason: `tópico "${topicId}" não existe` };
    found.topic.videoUrl = videoUrl;
    if (videoTitle) found.topic.videoTitle = videoTitle;
    // Mantém histórico cumulativo de vídeos vistos
    const hist = found.topic.watchedVideos ?? [];
    if (!hist.some((v) => v.url === videoUrl)) {
      hist.push({
        url: videoUrl,
        title: videoTitle ?? '',
        addedAt: nowIso(),
      });
      found.topic.watchedVideos = hist;
    }
    plan.updatedAt = nowIso();
    await this.persist(plan);
    return { ok: true };
  }

  /** Bloco compacto pra anexar ao system instruction do Gemini Live. */
  formatForPrompt(): string {
    const plans = this.list().filter((p) => p.status === 'active');
    if (plans.length === 0) return '';
    const lines = ['\n\nPLANOS DE ESTUDO ATIVOS (use as tools study_plan_*):'];
    for (const p of plans) {
      const pct =
        p.totalTopics > 0
          ? Math.round((p.doneTopics / p.totalTopics) * 100)
          : 0;
      lines.push(
        `- "${p.planId}" (dono: ${p.owner}, tema: ${p.topic}) — ` +
          `${p.doneTopics}/${p.totalTopics} tópicos (${pct}%) · ` +
          `atual: ${p.currentTopic ?? 'tudo feito!'}` +
          (p.currentModule ? ` (mód: ${p.currentModule})` : ''),
      );
    }
    return lines.join('\n');
  }

  /** Persiste JSON (fonte da verdade) e regenera o MD renderizado. */
  private async persist(plan: StudyPlan): Promise<void> {
    const jsonPath = planFile(plan.planId, 'json');
    const tmp = jsonPath + '.tmp';
    await writeFile(tmp, JSON.stringify(plan, null, 2), 'utf8');
    await rename(tmp, jsonPath);
    const mdPath = planFile(plan.planId, 'md');
    await writeFile(mdPath, renderMarkdown(plan), 'utf8');
  }
}

function statusLabel(s: TopicStatus): string {
  switch (s) {
    case 'done':
      return '✅';
    case 'in-progress':
      return '🟡';
    case 'skipped':
      return '⏭️';
    default:
      return '⬜';
  }
}

function renderMarkdown(plan: StudyPlan): string {
  const out: string[] = [];
  out.push('---');
  out.push(`plan_id: ${plan.planId}`);
  out.push(`owner: ${plan.owner}`);
  out.push(`topic: ${plan.topic}`);
  out.push(`status: ${plan.status}`);
  out.push(`updated: ${plan.updatedAt}`);
  out.push('---');
  out.push('');
  out.push(`# Plano de estudo: ${plan.topic}`);
  out.push('');
  out.push(`**Dono:** ${plan.owner}  `);
  out.push(`**Objetivo:** ${plan.goal}  `);
  out.push(
    `**Criado em:** ${plan.createdAt.slice(0, 10)} · **Atualizado:** ${plan.updatedAt.slice(0, 10)}  `,
  );
  const all = plan.modules.flatMap((m) => m.topics);
  const done = all.filter((t) => t.status === 'done').length;
  out.push(`**Progresso:** ${done}/${all.length} tópicos`);
  out.push('');

  for (const m of plan.modules) {
    out.push(`## ${m.title}`);
    if (m.objective) out.push(`*${m.objective}*`);
    out.push('');
    for (const t of m.topics) {
      out.push(`### ${statusLabel(t.status)} ${t.title}`);
      out.push(`- **id:** \`${t.id}\``);
      out.push(`- **status:** ${t.status}`);
      if (t.videoUrl) {
        out.push(`- **vídeo:** [${t.videoTitle ?? 'YouTube'}](${t.videoUrl})`);
      }
      if (t.startedAt) out.push(`- **iniciado:** ${t.startedAt.slice(0, 10)}`);
      if (t.completedAt) out.push(`- **concluído:** ${t.completedAt.slice(0, 10)}`);
      if (t.notes.trim()) {
        out.push('- **notas:**');
        for (const line of t.notes.split('\n')) {
          if (line.trim()) out.push(`  ${line}`);
        }
      }
      out.push('');
    }
  }
  return out.join('\n');
}

// Vídeos YouTube curados pelo GPT na conversa original com a Kamila.
// Aplicado em cima do plano após seed/load — só preenche topics com videoUrl
// vazio (não sobrescreve se ela já assistiu/marcou outro vídeo).
const KAMILA_CURATED_VIDEOS: Array<{
  topicMatch: string;
  videoUrl: string;
  videoTitle: string;
}> = [
  // Nível 1 — Fundamentos
  {
    topicMatch: 'co' /* CO₂ e os principais gases */,
    videoUrl: 'https://youtu.be/a9yO-K8mwL0',
    videoTitle: 'Pegada de carbono — explicação introdutória',
  },
  // Nível 2 — Introdução a créditos de carbono
  {
    topicMatch: 'o que é crédito de carbono',
    videoUrl: 'https://www.youtube.com/watch?v=2UokqI1JRds',
    videoTitle: 'Introdução total a créditos de carbono',
  },
  {
    topicMatch: 'quem compra crédito',
    videoUrl: 'https://www.youtube.com/watch?v=ZD1fI-R6Beo',
    videoTitle: 'Créditos de carbono — explicação simples e visual',
  },
  {
    topicMatch: 'tipos de projetos',
    videoUrl: 'https://www.youtube.com/watch?v=PgCByP8lQHk',
    videoTitle: 'Créditos de carbono na prática (exemplos reais)',
  },
  {
    topicMatch: 'compensação de emissões',
    videoUrl: 'https://www.youtube.com/watch?v=9GQJkZ1vYgQ',
    videoTitle: 'Créditos de carbono — explicação completa (quase aula)',
  },
  {
    topicMatch: 'mercado voluntário',
    videoUrl: 'https://www.youtube.com/watch?v=6tW0z8p7G3k',
    videoTitle: 'Mercado de carbono — visão geral',
  },
];

/** Preenche videoUrl dos tópicos curados pelo GPT (idempotente). */
export async function applyKamilaCuratedVideos(store: StudyPlanStore): Promise<void> {
  const plan = store.get('kamila-creditos-de-carbono');
  if (!plan) return;
  let patched = 0;
  for (const c of KAMILA_CURATED_VIDEOS) {
    const found = store.findTopic(plan, c.topicMatch);
    if (!found) {
      console.warn(`[study-plans] curado não casou: "${c.topicMatch}"`);
      continue;
    }
    if (found.topic.videoUrl) continue; // não sobrescreve
    const r = await store.setTopicVideo(
      plan.planId,
      found.topic.id,
      c.videoUrl,
      c.videoTitle,
    );
    if (r.ok) patched++;
  }
  if (patched > 0) {
    console.log(`[study-plans] curados ${patched} vídeo(s) preenchido(s) no plano da Kamila`);
  }
}

// Singleton — main inicializa via load() no startup; integrações usam direto.
let _instance: StudyPlanStore | null = null;
export function getStudyPlanStore(): StudyPlanStore {
  if (!_instance) _instance = new StudyPlanStore();
  return _instance;
}

/** Garante que o plano da Kamila esteja seedado na 1ª execução. Idempotente. */
export async function seedKamilaPlanIfMissing(store: StudyPlanStore): Promise<void> {
  const planId = 'kamila-creditos-de-carbono';
  if (store.get(planId)) return;
  if (existsSync(planFile(planId, 'json'))) return;
  const r = await store.create({
    planId,
    owner: 'Kamila',
    topic: 'Créditos de carbono',
    goal:
      'Sair do zero e se tornar especialista em créditos de carbono — base ' +
      'climática, mercados voluntário e regulado, MRV, padrões (Verra/Gold ' +
      'Standard) e atuação profissional com empresas.',
    modules: [
      {
        title: 'Nível 1 — Introdução ao meio ambiente e carbono',
        objective:
          'Entender CO₂, carbono, efeito estufa, camada de ozônio, poluição e sustentabilidade.',
        topics: [
          { title: 'Aquecimento global: o que é e o que causa' },
          { title: 'Efeito estufa e camada de ozônio' },
          { title: 'CO₂ e os principais gases de efeito estufa' },
          { title: 'Ciclo do carbono na natureza' },
          { title: 'Mudanças climáticas: causas e consequências' },
          { title: 'Ecossistemas e biodiversidade' },
          { title: 'Poluição e impacto ambiental' },
          { title: 'Conceito de sustentabilidade' },
        ],
      },
      {
        title: 'Nível 2 — Introdução a créditos de carbono',
        objective:
          'Entender o que são créditos de carbono, como surgiram e como funcionam mercados globais.',
        topics: [
          { title: 'O que é crédito de carbono — definição e exemplo prático' },
          { title: 'História: Protocolo de Kyoto e Acordo de Paris' },
          { title: 'Quem compra crédito de carbono e por quê' },
          { title: 'Tipos de projetos geradores de crédito' },
          { title: 'MRV: monitoramento, reporte e verificação' },
          { title: 'Adicionalidade — conceito e por que importa' },
          { title: 'Compensação de emissões: o que é e como funciona' },
          { title: 'Mercado voluntário vs regulado' },
        ],
      },
      {
        title: 'Nível 3 — Base técnica (GEE e MRV)',
        objective: 'Cálculos, monitoramento e relatórios de gases de efeito estufa.',
        topics: [
          { title: 'Tipos de gases de efeito estufa e potencial de aquecimento' },
          { title: 'Como medir emissões de uma empresa ou projeto' },
          { title: 'Inventário de emissões — passo a passo' },
          { title: 'Verificação por terceira parte' },
          { title: 'Material de MRV da FAO — leitura por capítulos' },
          { title: 'Estrutura de um projeto de carbono (PDD)' },
        ],
      },
      {
        title: 'Nível 4 — Intermediário / Mercado',
        objective:
          'Funcionamento prático, padrões globais e operação de mercados de carbono.',
        topics: [
          { title: 'Padrão Verra (VCS) — como funciona' },
          { title: 'Padrão Gold Standard — diferenças e nichos' },
          { title: 'Outros padrões: CDM, ACR, CAR' },
          { title: 'Tipos de projetos: florestais, energia, eficiência, agricultura' },
          { title: 'Compra e venda de créditos — como ocorre' },
          { title: 'Avaliação de risco em projetos de carbono' },
          { title: 'Contratos e ERPAs — referência básica' },
          { title: 'Casos reais de projetos brasileiros' },
        ],
      },
      {
        title: 'Nível 5 — Avançado / Especialista',
        objective:
          'Atuação profissional: falar com empresas e estruturar plataforma/serviço.',
        topics: [
          { title: 'Mercados voluntários no Brasil — panorama 2025' },
          { title: 'Mercados regulados — políticas e regulação no Brasil' },
          { title: 'Registro de projeto: passo a passo' },
          { title: 'Emissão de créditos — fluxo completo' },
          { title: 'Estratégia de compensação corporativa' },
          { title: 'Projetos reais — análise comparativa' },
          { title: 'Como apresentar serviço de carbono pra produtor rural' },
          { title: 'Como apresentar serviço de carbono pra empresa' },
        ],
      },
    ],
  });
  if (r.ok) {
    console.log(`[study-plans] plano da Kamila seedado em ${planFile(planId, 'json')}`);
  } else {
    console.warn('[study-plans] seed falhou:', r.reason);
  }
}
