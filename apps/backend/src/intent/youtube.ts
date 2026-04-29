import { YouTube } from 'youtube-sr';
import { logger } from '../logger.js';
import {
  apiLatestFromChannel,
  apiSearchByDate,
  apiSearchByViews,
  apiSearchFirst,
  isApiAvailable,
} from './youtube-api.js';

export type Prefer = 'top' | 'latest' | 'first';

const YOUTUBE_RESULTS_RE =
  /^https?:\/\/(?:www\.)?youtube\.com\/results\?(?:[^&#]*&)*search_query=([^&#]+)/i;

// Captura o primeiro videoId que está dentro de um `videoRenderer` (resultado de
// busca real). Evita pegar shorts, anúncios ou vídeos sugeridos que aparecem
// antes no HTML.
const VIDEO_RENDERER_RE = /"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})"/;

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121 Safari/537.36';

function watchUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

/** Pesquisa ordenada por upload date (sp=CAI%3D), extrai primeiro videoRenderer. */
async function fetchLatestVideoId(query: string): Promise<string | null> {
  // sp=CAI%3D = "sort by upload date" puro. CAISAhAB também tem o filtro mas
  // reordena por relevância, jogando vídeos antigos populares pra cima.
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=CAI%3D`;
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'pt-BR,pt;q=0.9' } });
    if (!res.ok) return null;
    const html = await res.text();
    const m = html.match(VIDEO_RENDERER_RE);
    return m ? m[1] : null;
  } catch (err) {
    logger.warn({ err, query }, 'youtube latest fetch failed');
    return null;
  }
}

/** Resolve via API oficial quando a chave existe. Devolve videoId ou null. */
async function resolveViaApi(query: string, prefer: Prefer): Promise<string | null> {
  if (!isApiAvailable()) return null;

  if (prefer === 'latest') {
    // 1ª tentativa: ler uploads do canal (3 unidades, ordenação real do YouTube)
    const fromChannel = await apiLatestFromChannel(query);
    if (fromChannel) return fromChannel;
    // 2ª tentativa: search.list ordenado por data (100 unidades)
    return apiSearchByDate(query);
  }
  if (prefer === 'top') return apiSearchByViews(query);
  if (prefer === 'first') return apiSearchFirst(query);
  return null;
}

/** Resolve uma query do YouTube pra URL de vídeo direto, conforme estratégia. */
export async function resolveYoutubeQuery(query: string, prefer: Prefer): Promise<string> {
  // 1. Caminho preferido: API oficial.
  const viaApi = await resolveViaApi(query, prefer);
  if (viaApi) {
    logger.info({ query, prefer, id: viaApi }, 'youtube resolved via api');
    return watchUrl(viaApi);
  }

  // 2. Fallback: scraping (sp=CAI%3D pra latest, youtube-sr pra outros).
  if (prefer === 'latest') {
    const id = await fetchLatestVideoId(query);
    if (id) {
      logger.info({ query, id, prefer }, 'youtube resolved via scraping (latest)');
      return watchUrl(id);
    }
    logger.warn({ query }, 'youtube latest scraping empty, falling back to top');
  }

  try {
    const results = await YouTube.search(query, { type: 'video', limit: 10, safeSearch: false });
    if (!results.length) {
      logger.warn({ query }, 'youtube search returned 0 results');
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    }

    let chosen;
    if (prefer === 'first') {
      chosen = results[0];
    } else {
      chosen = [...results].sort((a, b) => (b.views ?? 0) - (a.views ?? 0))[0] ?? results[0];
    }

    if (!chosen.id) {
      return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    }
    logger.info(
      { query, prefer, title: chosen.title, views: chosen.views, id: chosen.id },
      'youtube resolved via scraping',
    );
    return watchUrl(chosen.id);
  } catch (err) {
    logger.warn({ err, query }, 'youtube scraping failed');
    return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  }
}

/**
 * Mantido pra o caso do LLM ainda emitir open_url com URL de busca direta:
 * detecta e cai pra resolveYoutubeQuery com 'top'.
 */
export async function resolveYoutubeSearch(url: string): Promise<string> {
  const match = url.match(YOUTUBE_RESULTS_RE);
  if (!match) return url;
  const query = decodeURIComponent(match[1].replace(/\+/g, ' '));
  const resolved = await resolveYoutubeQuery(query, 'top');
  return resolved;
}
