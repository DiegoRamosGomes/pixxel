import 'dotenv/config';
import { z } from 'zod';

const ConfigSchema = z.object({
  PORT: z.coerce.number().int().positive().default(8080),
  HOST: z.string().default('0.0.0.0'),
  // Token compartilhado com o desktop. Cliente WS precisa apresentar no hello.
  CLIENT_TOKEN: z.string().min(8, 'CLIENT_TOKEN must be at least 8 chars'),
  // Caminho do SQLite (events queue).
  DB_PATH: z.string().default('./data/pixxel.db'),
  // Secret compartilhado com Expo na criação do webhook (eas webhook:create).
  // Usado pra validar `expo-signature` (HMAC SHA-1) em cada request.
  EXPO_WEBHOOK_SECRET: z.string().optional(),
});

export const config = ConfigSchema.parse(process.env);
export type Config = typeof config;
