// Classifier híbrido em 3 camadas:
//   1. RULES — match determinístico (senders sempre importantes, padrões de spam óbvio).
//   2. KNN sobre embeddings — vota com os K vizinhos mais próximos do corpus rotulado.
//   3. LLM tiebreaker — só quando KNN tá ambíguo (votos divididos ou poucos exemplos).
//
// Retorna { important, source } pra debug/log.

import { embed } from '../embeddings.js';
import { loadLabels, type LabelExample } from './labels.js';
import type { EmailMessage } from './gmail.js';

export type ClassifyResult = {
  important: boolean;
  source: 'rule' | 'knn' | 'llm' | 'fallback';
  detail?: string;
  /** Vetor calculado durante o classify — reaproveitado se o usuário rotular esse email depois. */
  vector?: number[];
};

const APP_STORE_STATUS_RE =
  /ready\s*for\s*sale|approved|aprovad[ao]|rejected|recusad[ao]|metadata\s+rejected|developer\s+rejected|disponivel\s+para\s+venda/i;

const ALWAYS_IMPORTANT_RULES = [
  {
    name: 'clickup',
    test: (m: EmailMessage) => /(?:@|\.)clickup\.com/i.test(m.from),
  },
  {
    name: 'girolabs',
    test: (m: EmailMessage) => /girolabs/i.test(m.from),
  },
  {
    name: 'app-store',
    test: (m: EmailMessage) => {
      const isAppStore =
        /app\s*store\s*connect/i.test(m.from) ||
        /no_reply@email\.apple\.com/i.test(m.from);
      return isAppStore && APP_STORE_STATUS_RE.test(m.subject);
    },
  },
];

// Padrões de "ruído quase certo" — newsletters, marketing automatizado.
// Manter conservador: só bate em remetentes obviamente automatizados.
const ALWAYS_NOT_IMPORTANT_RULES = [
  {
    name: 'no-reply',
    test: (m: EmailMessage) =>
      /(?:no[-_.]?reply|noreply|do[-_.]?not[-_.]?reply|donotreply)@/i.test(m.from) &&
      // mas se já é app-store, app-store rule decide primeiro
      !/apple\.com/i.test(m.from),
  },
  {
    name: 'marketing',
    test: (m: EmailMessage) =>
      /(?:newsletter|marketing|promo|notif(?:icaco|icati|y))@/i.test(m.from),
  },
];

function emailToText(m: EmailMessage): string {
  // Snippet pra embedding — assunto pesa mais que corpo.
  return `De: ${m.from}\nAssunto: ${m.subject}\n\n${m.snippet}`;
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

const KNN_K = 5;
// Confiança mínima da maioria pra decidir sem LLM. Ex: 4 de 5 (80%) decide;
// 3 de 5 (60%) cai pro LLM.
const KNN_CONFIDENCE_THRESHOLD = 0.75;
// Mínimo de exemplos no corpus pra KNN ter o que dizer.
const KNN_MIN_CORPUS = 6;

type KnnVote = {
  important: boolean;
  votes: number;
  total: number;
  topSimilarity: number;
};

function knnClassify(
  vector: number[],
  corpus: LabelExample[],
): KnnVote | null {
  if (corpus.length < KNN_MIN_CORPUS) return null;
  const scored = corpus
    .map((e) => ({ ex: e, sim: dot(vector, e.vector) }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, KNN_K);
  if (scored.length === 0) return null;
  const importantVotes = scored.filter((s) => s.ex.label === 'important').length;
  const notVotes = scored.length - importantVotes;
  const winning = importantVotes >= notVotes;
  const winnerVotes = winning ? importantVotes : notVotes;
  return {
    important: winning,
    votes: winnerVotes,
    total: scored.length,
    topSimilarity: scored[0].sim,
  };
}

async function llmTiebreaker(m: EmailMessage): Promise<boolean | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const prompt =
    'Você classifica emails como IMPORTANTE ou NAO_IMPORTANTE pra um ' +
    'desenvolvedor freelancer brasileiro. Importante = exige atenção/ação ' +
    'humana (cliente, ferramenta de trabalho, finanças, contas, prazos, ' +
    'algo que se ignorado pode dar problema). NÃO importante = newsletter, ' +
    'marketing, notificação automática que não exige ação, promoção, ' +
    'confirmação de coisa rotineira. Responda APENAS com "IMPORTANTE" ou ' +
    '"NAO_IMPORTANTE", uma palavra só.\n\n' +
    `De: ${m.from}\nAssunto: ${m.subject}\n\n${m.snippet}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 8, temperature: 0 },
        }),
      },
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text =
      json.candidates?.[0]?.content?.parts?.[0]?.text?.trim().toUpperCase() ?? '';
    if (text.includes('NAO') || text.includes('NÃO') || text.startsWith('NOT'))
      return false;
    if (text.startsWith('IMPORT')) return true;
    return null;
  } catch (err) {
    console.warn('[email/classifier] LLM falhou:', err);
    return null;
  }
}

export async function classifyEmail(m: EmailMessage): Promise<ClassifyResult> {
  // Camada 1: regras determinísticas.
  for (const r of ALWAYS_IMPORTANT_RULES) {
    if (r.test(m)) return { important: true, source: 'rule', detail: r.name };
  }
  for (const r of ALWAYS_NOT_IMPORTANT_RULES) {
    if (r.test(m)) return { important: false, source: 'rule', detail: r.name };
  }

  // Camada 2: KNN sobre corpus rotulado.
  let vector: number[] | undefined;
  try {
    vector = await embed(emailToText(m), 'RETRIEVAL_QUERY');
  } catch (err) {
    console.warn('[email/classifier] embed falhou, indo direto pro LLM:', err);
  }

  if (vector) {
    const corpus = await loadLabels();
    const vote = knnClassify(vector, corpus);
    if (vote) {
      const confidence = vote.votes / vote.total;
      if (confidence >= KNN_CONFIDENCE_THRESHOLD) {
        return {
          important: vote.important,
          source: 'knn',
          detail: `${vote.votes}/${vote.total} (sim=${vote.topSimilarity.toFixed(2)})`,
          vector,
        };
      }
    }
  }

  // Camada 3: LLM tiebreaker (KNN ambíguo ou corpus muito pequeno).
  const llm = await llmTiebreaker(m);
  if (llm !== null) {
    return { important: llm, source: 'llm', vector };
  }

  // Fallback: assume não-importante se nada decidiu (ex: sem GEMINI_API_KEY).
  return { important: false, source: 'fallback', vector };
}

export async function embedEmail(m: EmailMessage): Promise<number[]> {
  return embed(emailToText(m), 'RETRIEVAL_DOCUMENT');
}
