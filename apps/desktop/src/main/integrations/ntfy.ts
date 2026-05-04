// ntfy: push notifications pro celular via https://ntfy.sh.
// Configuração: NTFY_TOPIC (obrigatório) + NTFY_SERVER (default ntfy.sh).
// Inscreva o mesmo tópico no app ntfy do celular pra receber.

export function isNtfyAvailable(): boolean {
  return Boolean(process.env.NTFY_TOPIC);
}

export type NtfyPushOptions = {
  title?: string;
  /** 1 (min) a 5 (max). Default 3. */
  priority?: 1 | 2 | 3 | 4 | 5;
  /** Emojis/tags separados por vírgula. Ex: 'bell,warning'. */
  tags?: string;
  /** URL pra abrir ao tocar na notificação. */
  click?: string;
};

export async function sendPush(
  message: string,
  opts: NtfyPushOptions = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const topic = process.env.NTFY_TOPIC;
  if (!topic) return { ok: false, reason: 'NTFY_TOPIC não configurado' };
  const server = process.env.NTFY_SERVER ?? 'https://ntfy.sh';

  const headers: Record<string, string> = {};
  if (opts.title) headers['Title'] = opts.title;
  if (opts.priority) headers['Priority'] = String(opts.priority);
  if (opts.tags) headers['Tags'] = opts.tags;
  if (opts.click) headers['Click'] = opts.click;

  try {
    const res = await fetch(`${server.replace(/\/$/, '')}/${topic}`, {
      method: 'POST',
      body: message,
      headers,
    });
    if (!res.ok) {
      return { ok: false, reason: `ntfy ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : 'falhou ao enviar push',
    };
  }
}
