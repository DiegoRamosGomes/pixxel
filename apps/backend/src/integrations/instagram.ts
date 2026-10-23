// Instagram Graph API — read-only.
// Token (System User, sem expiração) vem de process.env.INSTAGRAM_API_KEY.
// IG Business Account ID fixo: ia.pixxel.

const BASE = 'https://graph.facebook.com/v21.0';
const IG_USER_ID = '17841424207940911'; // ia.pixxel

const TOKEN = () => process.env.INSTAGRAM_API_KEY ?? '';

export const isInstagramAvailable = (): boolean => Boolean(TOKEN());

export type InstagramMedia = {
  id: string;
  caption?: string;
  media_type: 'IMAGE' | 'VIDEO' | 'CAROUSEL_ALBUM' | 'REELS';
  media_url?: string;
  permalink: string;
  timestamp: string;
  like_count?: number;
  comments_count?: number;
};

export type InstagramProfile = {
  username: string;
  followers_count: number;
  follows_count: number;
  media_count: number;
};

async function igFetch<T>(
  path: string,
  params: Record<string, string> = {},
): Promise<T | null> {
  const token = TOKEN();
  if (!token) return null;
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('access_token', token);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      const body = await res.text();
      console.warn(
        `[instagram] api error ${res.status} on ${path}:`,
        body.slice(0, 300),
      );
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn('[instagram] fetch failed:', err);
    return null;
  }
}

export async function getProfile(): Promise<InstagramProfile | null> {
  return igFetch<InstagramProfile>(`/${IG_USER_ID}`, {
    fields: 'username,followers_count,follows_count,media_count',
  });
}

export async function listLatestMedia(limit = 10): Promise<InstagramMedia[] | null> {
  const data = await igFetch<{ data: InstagramMedia[] }>(`/${IG_USER_ID}/media`, {
    fields: 'id,caption,media_type,media_url,permalink,timestamp,like_count,comments_count',
    limit: String(limit),
  });
  return data?.data ?? null;
}

export type InstagramInsight = { name: string; values: Array<{ value: number }> };

export async function getMediaInsights(mediaId: string): Promise<InstagramInsight[] | null> {
  // Métricas variam por media_type; reach é universal.
  const data = await igFetch<{ data: InstagramInsight[] }>(`/${mediaId}/insights`, {
    metric: 'reach,likes,comments,saved,shares',
  });
  return data?.data ?? null;
}

async function igPost<T>(
  path: string,
  body: Record<string, string>,
): Promise<T | null> {
  const token = TOKEN();
  if (!token) return null;
  const params = new URLSearchParams({ ...body, access_token: token });
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      const txt = await res.text();
      console.warn(`[instagram] post error ${res.status} on ${path}:`, txt.slice(0, 300));
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn('[instagram] post failed:', err);
    return null;
  }
}

export type PublishResult =
  | { ok: true; mediaId: string; permalink?: string }
  | { ok: false; reason: string };

export type PublishOptions = {
  shareToFeed?: boolean;
};

// Fluxo de publicação: cria container → aguarda processar (vídeo) → publica.
// Reels: timeout de até 5min pra processar.
export async function publishMedia(
  mediaUrl: string,
  caption: string,
  isVideo: boolean,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const containerBody: Record<string, string> = { caption };
  if (isVideo) {
    containerBody.media_type = 'REELS';
    containerBody.video_url = mediaUrl;
    if (options.shareToFeed) containerBody.share_to_feed = 'true';
  } else {
    containerBody.image_url = mediaUrl;
  }

  const container = await igPost<{ id: string }>(
    `/${IG_USER_ID}/media`,
    containerBody,
  );
  if (!container) return { ok: false, reason: 'falhou ao criar container no Instagram' };

  // Vídeos precisam ser processados antes de publicar (status FINISHED).
  // Até 5min: 100 × 3s.
  if (isVideo) {
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const status = await igFetch<{ status_code: string }>(`/${container.id}`, {
        fields: 'status_code',
      });
      if (status?.status_code === 'FINISHED') break;
      if (status?.status_code === 'ERROR') {
        return { ok: false, reason: 'Instagram falhou ao processar o vídeo' };
      }
      if (i === 99) {
        return { ok: false, reason: 'timeout ao processar o vídeo (>5min)' };
      }
    }
  }

  const published = await igPost<{ id: string }>(
    `/${IG_USER_ID}/media_publish`,
    { creation_id: container.id },
  );
  if (!published) return { ok: false, reason: 'falhou ao publicar no Instagram' };

  const detail = await igFetch<{ permalink?: string }>(`/${published.id}`, {
    fields: 'permalink',
  });
  return { ok: true, mediaId: published.id, permalink: detail?.permalink };
}

export function formatProfileSummary(p: InstagramProfile): string {
  return `@${p.username} — ${p.followers_count} seguidores, ${p.media_count} posts.`;
}

export function formatMediaList(items: InstagramMedia[]): string {
  if (items.length === 0) return 'Sem posts.';
  return items
    .slice(0, 10)
    .map((m) => {
      const date = m.timestamp.slice(0, 10);
      const caption = (m.caption ?? '').replace(/\s+/g, ' ').slice(0, 80);
      const stats = `${m.like_count ?? 0}❤ ${m.comments_count ?? 0}💬`;
      return `• ${date} [${stats}] ${caption}`;
    })
    .join('\n');
}
