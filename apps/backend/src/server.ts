import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { logger } from './logger.js';
import { handleConnection } from './ws/handler.js';
import { registerExpoWebhook } from './webhooks/expo.js';
import { purgeOldDelivered } from './memory/db.js';

const app = Fastify({ loggerInstance: logger });

await app.register(websocket);

// Health check pra nginx / monitoring.
app.get('/health', async () => ({ status: 'ok' }));

// Webhook Expo (HMAC SHA-1 via header expo-signature).
registerExpoWebhook(app);

// WebSocket pro desktop (auth via hello + token).
app.get('/ws', { websocket: true }, (socket) => {
  handleConnection(socket);
});

// Limpeza periódica: webhook events entregues há mais de 30 dias somem.
setInterval(() => purgeOldDelivered(30), 24 * 60 * 60 * 1000);

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info({ port: config.PORT, host: config.HOST }, 'pixxel-backend listening');
} catch (err) {
  logger.error({ err }, 'failed to start');
  process.exit(1);
}
