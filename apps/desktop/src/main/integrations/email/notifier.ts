// Notificação no celular via ntfy.sh (ou self-hosted).
// Env vars: NTFY_SERVER (ex: https://ntfy.sh), NTFY_TOPIC (string única).
// Opcional: NTFY_TOKEN (Bearer auth se o server exigir).

const DEFAULT_MAX_LENGTH = 800;

export const isNtfyAvailable = (): boolean =>
  Boolean(process.env.NTFY_SERVER && process.env.NTFY_TOPIC);

export type NtfyOptions = {
  /** Título da notificação (push). */
  title?: string;
  /** baixo|normal|alto|máximo. ntfy aceita: min, low, default, high, max. */
  priority?: 'min' | 'low' | 'default' | 'high' | 'max';
  /** Tags em formato emoji ou nome (https://docs.ntfy.sh/emojis/). */
  tags?: string[];
  maxLength?: number;
};

function trim(text: string, maxLength: number): string {
  let s = text.replace(/\r\n?/g, '\n').trim();
  if (s.length > maxLength) s = s.slice(0, maxLength - 3).trimEnd() + '...';
  return s;
}

export async function sendNtfy(
  message: string,
  opts: NtfyOptions = {},
): Promise<{ ok: boolean; reason?: string }> {
  const server = process.env.NTFY_SERVER;
  const topic = process.env.NTFY_TOPIC;
  const token = process.env.NTFY_TOKEN;
  if (!server || !topic) {
    return { ok: false, reason: 'NTFY_SERVER/NTFY_TOPIC ausentes' };
  }
  const text = trim(message, opts.maxLength ?? DEFAULT_MAX_LENGTH);
  if (!text) return { ok: false, reason: 'mensagem vazia' };

  const url = `${server.replace(/\/+$/, '')}/${encodeURIComponent(topic)}`;
  const headers: Record<string, string> = {
    'content-type': 'text/plain; charset=utf-8',
  };
  if (opts.title) headers.title = opts.title;
  if (opts.priority) headers.priority = opts.priority;
  if (opts.tags && opts.tags.length > 0) headers.tags = opts.tags.join(',');
  if (token) headers.authorization = `Bearer ${token}`;

  try {
    const res = await fetch(url, { method: 'POST', headers, body: text });
    if (!res.ok) {
      const body = await res.text();
      return { ok: false, reason: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'fetch falhou',
    };
  }
}
