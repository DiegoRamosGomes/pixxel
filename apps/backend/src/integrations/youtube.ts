// YouTube via Data API v3. Sem fallback de scraping — exige YOUTUBE_API_KEY.
// Free tier: 10K units/dia. search.list = 100 units, channels.list = 1, playlistItems = 1.

const BASE = 'https://www.googleapis.com/youtube/v3';

type SearchItem = {
  id?: { videoId?: string; channelId?: string };
  snippet?: { title?: string; channelTitle?: string; description?: string };
};

type ChannelItem = {
  id: string;
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
};

type PlaylistItem = {
  snippet?: {
    resourceId?: { videoId?: string };
    title?: string;
  };
};

const KEY = () => process.env.YOUTUBE_API_KEY ?? '';

export const isYoutubeAvailable = (): boolean => Boolean(KEY());

async function fetchJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const key = KEY();
  if (!key) return null;
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', key);
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[youtube] api error ${res.status}:`, body.slice(0, 300));
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn('[youtube] fetch failed:', err);
    return null;
  }
}

export type YoutubeResolved = {
  videoId: string;
  title: string;
  channel: string;
  url: string;
};

function pickItem(item: SearchItem | undefined): YoutubeResolved | null {
  const id = item?.id?.videoId;
  if (!id) return null;
  return {
    videoId: id,
    title: item?.snippet?.title ?? '(sem título)',
    channel: item?.snippet?.channelTitle ?? '',
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

async function searchChannelId(query: string): Promise<string | null> {
  const data = await fetchJson<{ items: SearchItem[] }>('search', {
    q: query,
    type: 'channel',
    part: 'snippet',
    maxResults: '1',
  });
  return data?.items[0]?.id?.channelId ?? null;
}

async function getUploadsPlaylistId(channelId: string): Promise<string | null> {
  const data = await fetchJson<{ items: ChannelItem[] }>('channels', {
    id: channelId,
    part: 'contentDetails',
    maxResults: '1',
  });
  return data?.items[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
}

async function getLatestFromPlaylist(playlistId: string): Promise<YoutubeResolved | null> {
  const data = await fetchJson<{ items: PlaylistItem[] }>('playlistItems', {
    playlistId,
    part: 'snippet',
    maxResults: '1',
  });
  const item = data?.items[0];
  const videoId = item?.snippet?.resourceId?.videoId;
  if (!videoId) return null;
  return {
    videoId,
    title: item?.snippet?.title ?? '(sem título)',
    channel: '',
    url: `https://www.youtube.com/watch?v=${videoId}`,
  };
}

export type YoutubePrefer = 'top' | 'latest' | 'first';

export type YoutubeResolveOptions = {
  /**
   * Filtro de duração do YouTube. `medium` (4-20min) é ideal pra conteúdo
   * educativo e exclui Shorts. `any` deixa passar tudo (default — preserva
   * comportamento de "tocar música" que pode ser curta).
   */
  videoDuration?: 'short' | 'medium' | 'long' | 'any';
};

/** Resolve uma query do YouTube via API oficial conforme estratégia. */
export async function resolveYoutube(
  query: string,
  prefer: YoutubePrefer,
  options: YoutubeResolveOptions = {},
): Promise<YoutubeResolved | null> {
  if (!isYoutubeAvailable()) return null;
  const dur = options.videoDuration ?? 'any';
  const durParam: Record<string, string> =
    dur !== 'any' ? { videoDuration: dur } : {};

  // Bias pra resultados em pt-BR. relevanceLanguage + regionCode são hints
  // (não filtros), então também filtramos pelo idioma do título nos top N
  // pra reforçar.
  const ptParams = { relevanceLanguage: 'pt', regionCode: 'BR' };

  if (prefer === 'latest') {
    // 1ª: uploads do canal (3 unidades, ordenação real do YouTube)
    const channelId = await searchChannelId(query);
    if (channelId) {
      const playlistId = await getUploadsPlaylistId(channelId);
      if (playlistId) {
        const v = await getLatestFromPlaylist(playlistId);
        if (v) return v;
      }
    }
    // 2ª: search.list ordenado por data, filtrando pt
    const data = await fetchJson<{ items: SearchItem[] }>('search', {
      q: query,
      type: 'video',
      part: 'snippet',
      order: 'date',
      maxResults: '5',
      ...ptParams,
      ...durParam,
    });
    return pickPortuguese(data?.items) ?? pickItem(data?.items?.[0]);
  }

  if (prefer === 'top') {
    const data = await fetchJson<{ items: SearchItem[] }>('search', {
      q: query,
      type: 'video',
      part: 'snippet',
      order: 'viewCount',
      maxResults: '5',
      ...ptParams,
      ...durParam,
    });
    return pickPortuguese(data?.items) ?? pickItem(data?.items?.[0]);
  }

  // first
  const data = await fetchJson<{ items: SearchItem[] }>('search', {
    q: query,
    type: 'video',
    part: 'snippet',
    maxResults: '5',
    ...ptParams,
  });
  return pickPortuguese(data?.items) ?? pickItem(data?.items?.[0]);
}

/**
 * Busca top N vídeos em PT-BR pra uma query — usado quando queremos
 * alternativas (ex: "manda outro vídeo desse tópico"). Aplica mesmos
 * filtros heurísticos do pickPortuguese.
 */
export async function searchYoutubeMany(
  query: string,
  options: YoutubeResolveOptions = {},
  maxResults = 8,
): Promise<YoutubeResolved[]> {
  if (!isYoutubeAvailable()) return [];
  const dur = options.videoDuration ?? 'any';
  const durParam: Record<string, string> =
    dur !== 'any' ? { videoDuration: dur } : {};
  const data = await fetchJson<{ items: SearchItem[] }>('search', {
    q: query,
    type: 'video',
    part: 'snippet',
    order: 'viewCount',
    maxResults: String(maxResults),
    relevanceLanguage: 'pt',
    regionCode: 'BR',
    ...durParam,
  });
  if (!data?.items) return [];
  const PT_HINTS = /\b(que|de|para|como|uma|um|é|não|nao|com|em|no|na|da|do|os|as|pra|você|voce)\b/i;
  const EN_BLOCK = /\b(the|and|with|how to|what is|introduction|crash course)\b/i;
  return data.items
    .filter((item) => {
      const title = item?.snippet?.title ?? '';
      const desc = item?.snippet?.description ?? '';
      if (EN_BLOCK.test(title)) return false;
      return PT_HINTS.test(`${title} ${desc}`);
    })
    .map((item) => pickItem(item))
    .filter((x): x is YoutubeResolved => x !== null);
}

/**
 * Heurística pra detectar título em português. Pesa palavras funcionais
 * comuns em PT (que/de/para/como/uma/é/não/com/em/no/da/do) que dificilmente
 * aparecem juntas em outros idiomas. Retorna o primeiro item que parece PT.
 */
function pickPortuguese(
  items: SearchItem[] | undefined,
): YoutubeResolved | null {
  if (!items || items.length === 0) return null;
  const PT_HINTS = /\b(que|de|para|como|uma|um|é|não|nao|com|em|no|na|da|do|os|as|pra|você|voce)\b/i;
  const EN_BLOCK = /\b(the|and|with|how to|what is|introduction|crash course)\b/i;
  for (const item of items) {
    const title = item?.snippet?.title ?? '';
    const desc = item?.snippet?.description ?? '';
    const blob = `${title} ${desc}`;
    if (PT_HINTS.test(blob) && !EN_BLOCK.test(title)) {
      return pickItem(item);
    }
  }
  // Nenhum claramente PT — tenta o primeiro que NÃO seja claramente EN
  for (const item of items) {
    const title = item?.snippet?.title ?? '';
    if (!EN_BLOCK.test(title)) return pickItem(item);
  }
  return null;
}
