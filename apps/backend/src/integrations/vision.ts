// Olha pra câmera: pede 1 frame ao renderer, manda pro Gemini 2.5 Flash com a
// pergunta do usuário, devolve texto pronto pra o Live verbalizar.
//
// Caminho deliberadamente offline da sessão Live — Live é só áudio. Pra visão
// usamos REST do Flash (free tier folgado, ~250 req/dia) só sob demanda.

import { reserveGeminiRequest } from './gemini-quota.js';
import { isNvidiaAvailable, lookAtCameraNvidia } from './nvidia.js';

// 2.5-flash-lite: free tier muito maior que o 2.5-flash (~20 RPD na chave
// atual). Qualidade levemente menor mas suficiente pra descrever imagem da
// webcam. Pra subir qualidade volte pra 'gemini-2.5-flash'.
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * Captura de frame é do cliente (a câmera está no dispositivo). A API recebe
 * uma função que pede 1 frame com timeout e devolve data URL ou null.
 */
export type CaptureFrame = (timeoutMs: number) => Promise<string | null>;

export type LookAtCameraResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

const SYSTEM_PROMPT =
  'Você é os olhos de um assistente pessoal. Recebe uma imagem da webcam do ' +
  'usuário e uma pergunta. Responda em pt-BR, em 1-3 frases curtas, direto ao ' +
  'ponto. Sem introdução, sem markdown, sem listas. Se não der pra responder ' +
  'pela imagem (escuro demais, fora de foco, ângulo ruim), diga isso de forma ' +
  'curta. Não invente detalhes que não estão na imagem.';

const FRAME_COUNT = 3;
const FRAME_SPACING_MS = 300;

function parseDataUrl(
  dataUrl: string,
): { mimeType: string; base64: string } | null {
  const match = /^data:(image\/[a-zA-Z+]+);base64,(.+)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], base64: match[2] };
}

export async function lookAtCamera(
  question: string,
  captureFrame: CaptureFrame,
): Promise<LookAtCameraResult> {
  // Captura N frames espaçados — pega micro-movimento e ajuda em foco/blur.
  // Primeiro frame com timeout maior pra cobrir abertura da câmera; demais
  // são rápidos (stream já tá ao vivo).
  const frames: Array<{ mimeType: string; base64: string }> = [];
  for (let i = 0; i < FRAME_COUNT; i++) {
    const dataUrl = await captureFrame(i === 0 ? 4000 : 1500);
    if (!dataUrl) {
      if (i === 0) {
        return {
          ok: false,
          reason: 'câmera fechada ou indisponível — abra a câmera primeiro',
        };
      }
      // Frames subsequentes podem falhar isolados — continua com o que tem.
      break;
    }
    const parsed = parseDataUrl(dataUrl);
    if (parsed) frames.push(parsed);
    if (i < FRAME_COUNT - 1) {
      await new Promise((r) => setTimeout(r, FRAME_SPACING_MS));
    }
  }
  if (frames.length === 0) {
    return { ok: false, reason: 'frame inválido' };
  }

  const userQ = question.trim() || 'O que você está vendo na imagem?';

  // 1) Tenta Gemini primeiro se a cota local permitir. Se sucesso, retorna.
  // 2) Se cota esgotada OU Gemini falhar (429/HTTP/rede), cai pro NVIDIA NIM.
  // 3) Se NVIDIA também falhar, retorna o erro do NVIDIA (cobre o pior caso).
  const quota = await reserveGeminiRequest();
  if (quota.ok) {
    const geminiRes = await callGemini(userQ, frames);
    if (geminiRes.ok) {
      const finalText = quota.warn ? `${quota.warn}\n\n${geminiRes.text}` : geminiRes.text;
      return { ok: true, text: finalText };
    }
    console.warn('[vision] Gemini falhou, fallback NVIDIA:', geminiRes.reason);
  } else {
    console.log('[vision] cota Gemini esgotada — direto pro NVIDIA');
  }

  if (!isNvidiaAvailable()) {
    return {
      ok: false,
      reason: quota.ok
        ? 'Gemini falhou e NVIDIA não configurado'
        : quota.reason,
    };
  }

  const nv = await lookAtCameraNvidia(userQ, frames, SYSTEM_PROMPT);
  if (!nv.ok) {
    return { ok: false, reason: nv.reason };
  }
  // Aviso de cota só vale se chegou a tentar Gemini com warn.
  const prefix = quota.ok && quota.warn ? `${quota.warn}\n\n` : '';
  const fallbackNote = quota.ok
    ? '[via NVIDIA — Gemini falhou] '
    : '[via NVIDIA — cota Gemini esgotada hoje] ';
  return { ok: true, text: `${prefix}${fallbackNote}${nv.text}` };
}

async function callGemini(
  userQ: string,
  frames: Array<{ mimeType: string; base64: string }>,
): Promise<LookAtCameraResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return { ok: false, reason: 'GEMINI_API_KEY ausente' };
  const parts = [
    ...frames.map((f) => ({
      inlineData: { mimeType: f.mimeType, data: f.base64 },
    })),
    {
      text:
        frames.length > 1
          ? `Recebi ${frames.length} frames consecutivos (~${FRAME_SPACING_MS}ms ` +
            `entre eles) da webcam. Use-os juntos pra entender movimento ou ` +
            `gesto se houver. Pergunta: ${userQ}`
          : userQ,
    },
  ];
  try {
    const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 200 },
      }),
    });
    if (res.status === 429) return { ok: false, reason: 'Gemini 429' };
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, reason: `Gemini HTTP ${res.status} ${body.slice(0, 120)}` };
    }
    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
    if (!text) return { ok: false, reason: 'Gemini resposta vazia' };
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Gemini fetch falhou: ${msg}` };
  }
}
