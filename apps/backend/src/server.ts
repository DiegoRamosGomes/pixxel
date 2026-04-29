import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { logger } from './logger.js';
import { handleConnection } from './ws/handler.js';
import './memory/db.js';

const app = Fastify({ loggerInstance: logger });

await app.register(websocket);

app.get('/health', async () => ({ status: 'ok' }));

app.get('/ws', { websocket: true }, (socket) => {
  handleConnection(socket);
});

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT }, 'backend listening');
} catch (err) {
  logger.error({ err }, 'failed to start');
  process.exit(1);
}
