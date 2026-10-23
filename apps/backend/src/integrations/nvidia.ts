// Fallback NVIDIA NIM (OpenAI-compatible) pra quando o Gemini falhar ou a
// cota local diária estiver esgotada. Usa LLM_API_KEY/LLM_BASE_URL do .env
// — as mesmas envs do backend antigo (que está em standby).
//
// Modelo padrão: meta/llama-3.2-90b-vision-instruct (vision + texto). Pra
// chamadas só de texto também serve, ou pode-se trocar por um text-only
// como meta/llama-3.3-70b-instruct.

// 11B testado e respondendo. O 90B trava (timeout >60s, provável overload no
// free tier público). Pra forçar 90B, define NVIDIA_VISION_MODEL no .env.
const VISION_MODEL =
  process.env.NVIDIA_VISION_MODEL || 'meta/llama-3.2-11b-vision-instruct';
const TEXT_MODEL =
  process.env.NVIDIA_TEXT_MODEL || 'meta/llama-3.3-70b-instruct';

function getEndpoint(): string {
  const base = process.env.LLM_BASE_URL || 'https://integrate.api.nvidia.com/v1';
  return `${base.replace(/\/$/, '')}/chat/completions`;
}

export function isNvidiaAvailable(): boolean {
  return Boolean(process.env.LLM_API_KEY);
}

export type NvidiaResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

type Image = { mimeType: string; base64: string };

const NVIDIA_TIMEOUT_MS = 25_000;

async function callNvidia(body: Record<string, unknown>): Promise<NvidiaResult> {
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) return { ok: false, reason: 'LLM_API_KEY ausente' };
  const payload = JSON.stringify(body);
  console.log(
    `[nvidia] POST ${getEndpoint()} model=${(body as { model?: string }).model} bodySize=${payload.length}B`,
  );
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NVIDIA_TIMEOUT_MS);
  try {
    const res = await fetch(getEndpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
      },
      body: payload,
      signal: ctrl.signal,
    });
    const elapsed = Date.now() - startedAt;
    console.log(`[nvidia] resposta status=${res.status} em ${elapsed}ms`);
    if (res.status === 429) {
      return { ok: false, reason: 'NVIDIA NIM rate limit (429)' };
    }
    if (!res.ok) {
      const tx = await res.text().catch(() => '');
      console.warn(`[nvidia] HTTP ${res.status}: ${tx.slice(0, 300)}`);
      return {
        ok: false,
        reason: `NVIDIA HTTP ${res.status} ${tx.slice(0, 200)}`,
      };
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) return { ok: false, reason: 'NVIDIA resposta vazia' };
    console.log(`[nvidia] ok, ${text.length} chars`);
    return { ok: true, text };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn(`[nvidia] timeout após ${NVIDIA_TIMEOUT_MS}ms`);
      return { ok: false, reason: `NVIDIA timeout (${NVIDIA_TIMEOUT_MS}ms)` };
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[nvidia] fetch falhou: ${msg}`);
    return { ok: false, reason: `NVIDIA fetch falhou: ${msg}` };
  } finally {
    clearTimeout(timer);
  }
}

export async function lookAtCameraNvidia(
  question: string,
  frames: Image[],
  systemPrompt: string,
): Promise<NvidiaResult> {
  if (frames.length === 0) {
    return { ok: false, reason: 'sem frames pra enviar' };
  }
  // NIM tem limite de body (~250KB) e a maior parte dos modelos vision aceita
  // só 1 imagem mesmo. Manda o frame do meio (mais estável que o 1º que pode
  // estar borrado).
  const f = frames[Math.floor(frames.length / 2)];
  const userContent: Array<Record<string, unknown>> = [
    {
      type: 'image_url',
      image_url: { url: `data:${f.mimeType};base64,${f.base64}` },
    },
    { type: 'text', text: question },
  ];

  return callNvidia({
    model: VISION_MODEL,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    max_tokens: 200,
    temperature: 0.4,
    stream: false,
  });
}

export async function summarizeTextNvidia(prompt: string): Promise<NvidiaResult> {
  return callNvidia({
    model: TEXT_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 400,
    temperature: 0.4,
    stream: false,
  });
}
