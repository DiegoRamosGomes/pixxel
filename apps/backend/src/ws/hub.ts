// Registry de clientes WS conectados + delivery de webhook events.
//
// Pattern de entrega:
//   1. Webhook chega → insertWebhookEvent + tenta tryDeliver
//   2. tryDeliver: pra cada client conectado, manda webhook_event via WS
//   3. Client responde com webhook_ack { eventId } → markWebhookDelivered
//   4. Sem ack: evento fica pendente, próxima reconexão re-envia (drainPending)

import type { WebSocket } from '@fastify/websocket';
import type { ServerEvent } from '@assistant/shared';
import {
  listPendingWebhookEvents,
  markWebhookDelivered,
  incrementWebhookRetry,
  type WebhookEventRow,
} from '../memory/db.js';
import { logger } from '../logger.js';

// Conexões ativas. Pode ter mais de uma se o usuário abrir o desktop
// em duas máquinas — ambas recebem (broadcast).
const clients = new Set<WebSocket>();

function send(socket: WebSocket, event: ServerEvent): boolean {
  try {
    socket.send(JSON.stringify(event));
    return true;
  } catch (err) {
    logger.warn({ err }, 'ws send failed');
    return false;
  }
}

function rowToEvent(row: WebhookEventRow): ServerEvent {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    /* malformed — manda objeto vazio */
  }
  return {
    type: 'webhook_event',
    eventId: row.id,
    provider: row.provider,
    eventKind: row.event_kind,
    receivedAt: row.received_at,
    data,
  };
}

export function registerClient(socket: WebSocket): void {
  clients.add(socket);
  logger.info({ size: clients.size }, 'ws client registered');
}

export function unregisterClient(socket: WebSocket): void {
  clients.delete(socket);
  logger.info({ size: clients.size }, 'ws client unregistered');
}

/** Drena todos os pendentes pro cliente recém-conectado. */
export function drainPendingToClient(socket: WebSocket): void {
  const pending = listPendingWebhookEvents();
  if (pending.length === 0) return;
  logger.info({ count: pending.length }, 'draining pending webhook events');
  for (const row of pending) {
    const ok = send(socket, rowToEvent(row));
    if (!ok) {
      incrementWebhookRetry(row.id);
      break; // socket morreu, para de tentar
    }
  }
}

/** Tenta entregar um evento recém-recebido pra todos os clients ativos.
 *  Se ninguém conectado, fica na fila pra próxima reconexão. */
export function tryDeliverToAll(row: WebhookEventRow): void {
  if (clients.size === 0) {
    logger.info({ id: row.id }, 'no clients connected — event queued');
    return;
  }
  const event = rowToEvent(row);
  for (const socket of clients) send(socket, event);
}

/** Marca como entregue após receber ack do cliente. */
export function ackWebhookEvent(eventId: string): void {
  markWebhookDelivered(eventId);
}
