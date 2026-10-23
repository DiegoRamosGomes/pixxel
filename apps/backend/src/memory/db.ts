// SQLite simples pra fila de webhook events.
// Schema: cada evento recebido fica até ser entregue (delivered_at != null).
// Ao reconectar, o desktop drena a fila ordenada por received_at.

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

const dbPath = resolve(process.cwd(), config.DB_PATH);
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    event_kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    received_at INTEGER NOT NULL,
    delivered_at INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_webhook_pending
    ON webhook_events(delivered_at, received_at);
`);

logger.info({ dbPath }, 'sqlite ready');

export type WebhookEventRow = {
  id: string;
  provider: string;
  event_kind: string;
  payload: string;
  received_at: number;
  delivered_at: number | null;
  retry_count: number;
};

const stmts = {
  insert: db.prepare(
    `INSERT INTO webhook_events (id, provider, event_kind, payload, received_at)
     VALUES (?, ?, ?, ?, ?)`,
  ),
  listPending: db.prepare(
    `SELECT * FROM webhook_events WHERE delivered_at IS NULL ORDER BY received_at ASC`,
  ),
  markDelivered: db.prepare(
    `UPDATE webhook_events SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL`,
  ),
  // Limpeza opcional: eventos entregues há mais de N dias podem ser purgados.
  purgeOldDelivered: db.prepare(
    `DELETE FROM webhook_events WHERE delivered_at IS NOT NULL AND delivered_at < ?`,
  ),
};

export function insertWebhookEvent(input: {
  id: string;
  provider: string;
  eventKind: string;
  payload: unknown;
}): void {
  stmts.insert.run(
    input.id,
    input.provider,
    input.eventKind,
    JSON.stringify(input.payload),
    Date.now(),
  );
}

export function listPendingWebhookEvents(): WebhookEventRow[] {
  return stmts.listPending.all() as WebhookEventRow[];
}

export function markWebhookDelivered(id: string): void {
  stmts.markDelivered.run(Date.now(), id);
}

/** Limpa eventos entregues há mais de `daysAgo` dias. Chamar periodicamente. */
export function purgeOldDelivered(daysAgo = 30): void {
  const cutoff = Date.now() - daysAgo * 24 * 60 * 60 * 1000;
  const r = stmts.purgeOldDelivered.run(cutoff);
  if (r.changes > 0) logger.info({ removed: r.changes }, 'purged old webhooks');
}
