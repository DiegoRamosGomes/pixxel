import { config } from '../config.js';
import { logger } from '../logger.js';

const BASE = 'https://www.googleapis.com/youtube/v3';

type SearchItem = {
  id?: { videoId?: string; channelId?: string };
  snippet?: { title?: string; channelTitle?: string };
};

type ChannelItem = {
  id: string;
  contentDetails?: { relatedPlaylists?: { uploads?: string } };
};

type PlaylistItem = {
  snippet?: {
    resourceId?: { videoId?: string };
    title?: string;
    publishedAt?: string;
  };
};

async function fetchJson<T>(path: string, params: Record<string, string>): Promise<T | null> {
  if (!config.YOUTUBE_API_KEY) return null;
  const url = new URL(`${BASE}/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', config.YOUTUBE_API_KEY);

  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text();
      logger.warn({ status: res.status, body: body.slice(0, 300) }, 'youtube api error');
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    logger.warn({ err }, 'youtube api fetch failed');
    return null;
  }
}

/** Busca o canal mais relevante para a query e devolve o ID. */
async function searchChannelId(query: string): Promise<string | null> {
  const data = await fetchJson<{ items: SearchItem[] }>('search', {
    q: query,
    type: 'channel',
    part: 'snippet',
    maxResults: '1',
  });
  return data?.items[0]?.id?.channelId ?? null;
}

/** Pega o playlist ID de uploads de um canal. */
async function getUploadsPlaylistId(channelId: string): Promise<string | null> {
  const data = await fetchJson<{ items: ChannelItem[] }>('channels', {
    id: channelId,
    part: 'contentDetails',
    maxResults: '1',
  });
  return data?.items[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
}

/** Último vídeo de uma playlist (uploads do canal). */
async function getLatestVideoFromPlaylist(playlistId: string): Promise<string | null> {
  const data = await fetchJson<{ items: PlaylistItem[] }>('playlistItems', {
    playlistId,
    part: 'snippet',
    maxResults: '1',
  });
  const item = data?.items[0];
  if (item?.snippet?.resourceId?.videoId) {
    logger.info(
      { videoId: item.snippet.resourceId.videoId, title: item.snippet.title, publishedAt: item.snippet.publishedAt },
      'youtube api: latest from channel uploads',
    );
    return item.snippet.resourceId.videoId;
  }
  return null;
}

/** Caminho completo: query → canal → uploads → último vídeo. 3 unidades. */
export async function apiLatestFromChannel(query: string): Promise<string | null> {
  const channelId = await searchChannelId(query);
  if (!channelId) return null;
  const playlistId = await getUploadsPlaylistId(channelId);
  if (!playlistId) return null;
  return getLatestVideoFromPlaylist(playlistId);
}

/** Busca por data ordenada. Útil quando query é descritiva, não nome de canal. */
export async function apiSearchByDate(query: string): Promise<string | null> {
  const data = await fetchJson<{ items: SearchItem[] }>('search', {
    q: query,
    type: 'video',
    part: 'snippet',
    order: 'date',
    maxResults: '1',
  });
  return data?.items[0]?.id?.videoId ?? null;
}

/** Busca por views (top vídeo). 100 unidades. */
export async function apiSearchByViews(query: string): Promise<string | null> {
  const data = await fetchJson<{ items: SearchItem[] }>('search', {
    q: query,
    type: 'video',
    part: 'snippet',
    order: 'viewCount',
    maxResults: '1',
  });
  return data?.items[0]?.id?.videoId ?? null;
}

/** Primeiro resultado (relevância). 100 unidades. */
export async function apiSearchFirst(query: string): Promise<string | null> {
  const data = await fetchJson<{ items: SearchItem[] }>('search', {
    q: query,
    type: 'video',
    part: 'snippet',
    maxResults: '1',
  });
  return data?.items[0]?.id?.videoId ?? null;
}

export const isApiAvailable = (): boolean => Boolean(config.YOUTUBE_API_KEY);
