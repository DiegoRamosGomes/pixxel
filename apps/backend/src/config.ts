import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  CLIENT_TOKEN: z.string().min(8, 'CLIENT_TOKEN must be at least 8 chars'),
  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1),
  LLM_MODELS: z
    .string()
    .min(1)
    .transform((s) => s.split(',').map((m) => m.trim()).filter(Boolean))
    .pipe(z.array(z.string().min(1)).min(1, 'LLM_MODELS must list at least one model')),
  DB_PATH: z.string().default('./data/assistant.db'),
  YOUTUBE_API_KEY: z.string().optional(),
  CLICKUP_TOKEN: z.string().optional(),
  CLICKUP_TASK_PREFIX: z.string().optional(),
});

export const config = ConfigSchema.parse(process.env);
export type Config = typeof config;
