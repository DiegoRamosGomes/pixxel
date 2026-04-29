import OpenAI from 'openai';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const llm = new OpenAI({
  baseURL: config.LLM_BASE_URL,
  apiKey: config.LLM_API_KEY,
});

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

export type StreamCallbacks = {
  /** Chamado uma vez quando o stream começa, antes de qualquer delta. */
  onStart: (model: string) => void;
  /** Chamado a cada delta. */
  onDelta: (delta: string) => void;
};

export type StreamResult = {
  fullText: string;
  model: string;
};

function isRetryable(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 429) return true;
    if (err.status && err.status >= 500 && err.status < 600) return true;
    if (err.code === 'model_not_found' || err.code === 'invalid_model') return true;
  }
  return false;
}

export async function streamChat(
  messages: ChatMessage[],
  cb: StreamCallbacks,
): Promise<StreamResult> {
  const errors: Array<{ model: string; error: unknown }> = [];

  for (const model of config.LLM_MODELS) {
    try {
      const startedAt = Date.now();
      const stream = await llm.chat.completions.create({
        model,
        messages,
        stream: true,
        temperature: 0.5,
        top_p: 1,
        max_tokens: 1024,
      });

      cb.onStart(model);

      let fullText = '';
      let firstChunkAt: number | null = null;
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) {
          if (firstChunkAt === null) firstChunkAt = Date.now();
          fullText += delta;
          cb.onDelta(delta);
        }
      }

      logger.info(
        {
          model,
          ttfbMs: firstChunkAt ? firstChunkAt - startedAt : null,
          totalMs: Date.now() - startedAt,
          chars: fullText.length,
        },
        'llm stream complete',
      );

      return { fullText, model };
    } catch (err) {
      errors.push({ model, error: err });
      if (!isRetryable(err)) {
        logger.error({ model, err }, 'llm non-retryable error');
        throw err;
      }
      logger.warn({ model, err }, 'llm model failed, falling back to next');
    }
  }

  logger.error({ errors }, 'all llm models failed');
  throw new Error('all_models_failed');
}
