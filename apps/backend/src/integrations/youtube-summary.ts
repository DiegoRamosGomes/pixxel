// Resumo de vídeo do YouTube. Tenta primeiro pegar a legenda (rápido, leve);
// se não tiver caption, cai pro Gemini multimodal com a URL (mais caro/lento).
//
// Em ambos os caminhos chama o Gemini text-only pra gerar o resumo final em
// pt-BR pronto pro Live verbalizar.

import { YoutubeTranscript } from 'youtube-transcript';
import { reserveGeminiRequest } from './gemini-quota.js';
import { isNvidiaAvailable, summarizeTextNvidia } from './nvidia.js';

// 2.5-flash-lite: free tier maior que o 2.5-flash. Resumo de transcript não
// precisa do modelo grande. Pra resumo de vídeo direto (multimodal) talvez
// queira voltar pro 2.5-flash se a qualidade não for suficiente.
const GEMINI_MODEL = 'gemini-2.5-flash-lite';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const SUMMARY_PROMPT =
  'Resuma este vídeo em pt-BR, em 3 a 5 frases curtas. Foque no conteúdo ' +
  'principal e nas conclusões. Sem introdução do tipo "este vídeo fala sobre" ' +
  '— vai direto ao ponto. Sem listas, sem markdown.';

export type YoutubeSummaryResult =
  | { ok: true; summary: string; via: 'transcript' | 'multimodal'; videoId: string }
  | { ok: false; reason: string; videoId?: string };

export function isYoutubeSummaryAvailable(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

function extractVideoId(input: string): string | null {
  const trimmed = input.trim();
  // Já é um ID de 11 chars?
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  // URL completa
  try {
    const url = new URL(trimmed);
    if (url.hostname === 'youtu.be') {
      return url.pathname.slice(1).split('/')[0] || null;
    }
    const v = url.searchParams.get('v');
    if (v) return v;
    // /shorts/ID ou /embed/ID
    const m = url.pathname.match(/\/(?:shorts|embed|v)\/([a-zA-Z0-9_-]{11})/);
    if (m) return m[1];
  } catch {
    /* não é URL válida */
  }
  return null;
}

async function geminiText(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY ausente');
  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
    }),
  });
  if (res.status === 429) {
    throw new Error('429');
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('resposta vazia do Gemini');
  return text;
}

async function geminiMultimodal(youtubeUrl: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY ausente');
  const res = await fetch(`${GEMINI_ENDPOINT}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          role: 'user',
          parts: [
            { fileData: { fileUri: youtubeUrl, mimeType: 'video/youtube' } },
            { text: SUMMARY_PROMPT },
          ],
        },
      ],
      generationConfig: { temperature: 0.4, maxOutputTokens: 400 },
    }),
  });
  if (res.status === 429) {
    throw new Error('429');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) throw new Error('resposta vazia do Gemini');
  return text;
}

async function fetchTranscript(videoId: string): Promise<string | null> {
  // Tenta pt primeiro, depois en, depois qualquer disponível.
  const tries: Array<{ lang?: string }> = [{ lang: 'pt' }, { lang: 'en' }, {}];
  for (const opts of tries) {
    try {
      const segments = await YoutubeTranscript.fetchTranscript(videoId, opts);
      if (segments && segments.length > 0) {
        return segments
          .map((s) => s.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
    } catch {
      /* tenta próxima */
    }
  }
  return null;
}

export async function summarizeYoutubeVideo(
  urlOrId: string,
): Promise<YoutubeSummaryResult> {
  const videoId = extractVideoId(urlOrId);
  if (!videoId) {
    return { ok: false, reason: 'URL ou ID de vídeo inválido' };
  }
  const fullUrl = `https://www.youtube.com/watch?v=${videoId}`;

  // Caminho 1: transcript (rápido, leve).
  let transcript: string | null = null;
  try {
    transcript = await fetchTranscript(videoId);
  } catch (err) {
    console.warn('[yt-summary] transcript falhou:', err);
  }

  // Se temos transcript: tenta Gemini se cota deixar; senão fallback NVIDIA.
  if (transcript && transcript.length > 100) {
    const trimmed = transcript.length > 60000 ? transcript.slice(0, 60000) : transcript;
    const fullPrompt = `${SUMMARY_PROMPT}\n\nTranscrição do vídeo:\n${trimmed}`;

    const quota = await reserveGeminiRequest();
    if (quota.ok) {
      try {
        const summary = await geminiText(fullPrompt);
        const final = quota.warn ? `${quota.warn}\n\n${summary}` : summary;
        return { ok: true, summary: final, via: 'transcript', videoId };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[yt-summary] Gemini falhou, fallback NVIDIA:', msg);
        // Cai pro NVIDIA abaixo.
      }
    } else {
      console.log('[yt-summary] cota Gemini esgotada — direto NVIDIA');
    }

    if (isNvidiaAvailable()) {
      const nv = await summarizeTextNvidia(fullPrompt);
      if (nv.ok) {
        const prefix = quota.ok && quota.warn ? `${quota.warn}\n\n` : '';
        const note = quota.ok ? '[via NVIDIA] ' : '[via NVIDIA — cota Gemini esgotada] ';
        return {
          ok: true,
          summary: `${prefix}${note}${nv.text}`,
          via: 'transcript',
          videoId,
        };
      }
      console.warn('[yt-summary] NVIDIA também falhou:', nv.reason);
    }
    // Sem transcript-summary disponível — tenta multimodal abaixo.
  }

  // Caminho 2: Gemini multimodal com URL (sem fallback NVIDIA porque NIM
  // não aceita URL de YouTube como input — apenas imagens).
  const quota2 = await reserveGeminiRequest();
  if (!quota2.ok) {
    return { ok: false, reason: quota2.reason, videoId };
  }
  try {
    const summary = await geminiMultimodal(fullUrl);
    const final = quota2.warn ? `${quota2.warn}\n\n${summary}` : summary;
    return { ok: true, summary: final, via: 'multimodal', videoId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === '429') {
      return {
        ok: false,
        reason: 'esse vídeo é muito longo ou o limite do Gemini foi atingido — não consegui resumir',
        videoId,
      };
    }
    return {
      ok: false,
      reason: `não consegui resumir esse vídeo (${msg})`,
      videoId,
    };
  }
}
