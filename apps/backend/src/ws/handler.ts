// Conexão WS pro desktop. Apenas auth (hello + token) + webhook_ack.
// Sem chat/dispatcher — esse backend é só hub de webhooks agora.

import type { WebSocket } from '@fastify/websocket';
import { ClientEventSchema, type ServerEvent } from '@assistant/shared';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  registerClient,
  unregisterClient,
  drainPendingToClient,
  ackWebhookEvent,
} from './hub.js';

function send(socket: WebSocket, event: ServerEvent): void {
  socket.send(JSON.stringify(event));
}

export function handleConnection(socket: WebSocket): void {
  let authed = false;
  logger.info('ws client connected');

  socket.on('message', (raw: Buffer) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send(socket, { type: 'error', code: 'invalid_json', message: 'invalid json' });
      return;
    }

    const result = ClientEventSchema.safeParse(parsed);
    if (!result.success) {
      send(socket, {
        type: 'error',
        code: 'invalid_event',
        message: result.error.message,
      });
      return;
    }
    const event = result.data;

    if (event.type === 'hello') {
      if (event.token !== config.CLIENT_TOKEN) {
        send(socket, { type: 'error', code: 'unauthorized', message: 'bad token' });
        socket.close(1008, 'unauthorized');
        return;
      }
      authed = true;
      send(socket, { type: 'hello_ok', sessionId: event.sessionId });
      logger.info({ sessionId: event.sessionId }, 'ws authed');
      registerClient(socket);
      // Drena pendentes assíncrono pra não bloquear o hello_ok.
      setImmediate(() => drainPendingToClient(socket));
      return;
    }

    if (!authed) {
      send(socket, { type: 'error', code: 'unauthorized', message: 'send hello first' });
      return;
    }

    if (event.type === 'webhook_ack') {
      ackWebhookEvent(event.eventId);
      return;
    }

    // user_message: removido da nova arquitetura. Backend não fala mais com LLM.
    if (event.type === 'user_message') {
      send(socket, {
        type: 'error',
        code: 'unsupported',
        message: 'user_message não é mais suportado neste backend',
      });
      return;
    }
  });

  socket.on('close', () => {
    logger.info('ws client disconnected');
    unregisterClient(socket);
  });

  socket.on('error', (err: Error) => {
    logger.warn({ err }, 'ws error');
    unregisterClient(socket);
  });
}
