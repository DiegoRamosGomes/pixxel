// Pesquisa web via Tavily (https://tavily.com). API simples REST que retorna
// snippets já limpos prontos pro Gemini ler e sintetizar uma resposta.
//
// Free tier: 1k requests/mês. Chave em TAVILY_API_KEY.

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const MAX_RESULTS = 5;
const DEFAULT_TIMEOUT_MS = 12_000;

export type TavilyResult = {
  title: string;
  url: string;
  /** Trecho de texto extraído da página (até ~500 chars). */
  content: string;
  /** Relevância 0-1. */
  score?: number;
};

export type WebSearchOutcome =
  | {
      ok: true;
      query: string;
      /** Resposta sintética que o Tavily monta combinando os top resultados. */
      answer: string;
      results: TavilyResult[];
    }
  | { ok: false; reason: string };

export function isWebSearchAvailable(): boolean {
  return !!process.env.TAVILY_API_KEY;
}

export async function searchWeb(query: string): Promise<WebSearchOutcome> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    return { ok: false, reason: 'TAVILY_API_KEY não configurada' };
  }
  const q = query.trim();
  if (!q) return { ok: false, reason: 'query vazia' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query: q,
        search_depth: 'basic',
        max_results: MAX_RESULTS,
        include_answer: true,
        include_raw_content: false,
        include_images: false,
        // Usuário mora em Encarnación, PY — viesa pra fontes locais/nacionais
        // pra evitar resultado BR vindo de "feriado de hoje" etc.
        country: 'paraguay',
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        reason: `Tavily HTTP ${res.status}: ${body.slice(0, 200) || res.statusText}`,
      };
    }
    const data = (await res.json()) as {
      answer?: string;
      results?: Array<{ title?: string; url?: string; content?: string; score?: number }>;
    };
    const results: TavilyResult[] = (data.results ?? [])
      .filter((r) => r.url && r.title)
      .map((r) => ({
        title: r.title!.trim(),
        url: r.url!,
        content: (r.content ?? '').trim(),
        score: r.score,
      }))
      .slice(0, MAX_RESULTS);
    return {
      ok: true,
      query: q,
      answer: (data.answer ?? '').trim(),
      results,
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'falha desconhecida',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Texto pronto pro Gemini Live ler como toolResponse. */
export function formatSearchForVoice(outcome: Extract<WebSearchOutcome, { ok: true }>): string {
  const lines: string[] = [];
  lines.push(`Pesquisa: "${outcome.query}".`);
  if (outcome.answer) {
    lines.push('Resposta sintética: ' + outcome.answer);
  }
  if (outcome.results.length > 0) {
    lines.push('\nFontes encontradas:');
    outcome.results.forEach((r, i) => {
      const snippet = r.content.length > 280 ? r.content.slice(0, 280) + '…' : r.content;
      lines.push(`${i + 1}. ${r.title} — ${snippet}`);
    });
    lines.push(
      '\nUse os trechos pra montar uma resposta natural e curta (2-3 frases). ' +
        'Cite as fontes pelo nome (do título) quando relevante. Não fale URLs.',
    );
  }
  return lines.join('\n');
}
