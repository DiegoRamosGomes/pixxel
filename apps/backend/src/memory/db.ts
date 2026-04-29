import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';

const dbPath = resolve(process.cwd(), config.DB_PATH);
mkdirSync(dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant')),
    content TEXT NOT NULL,
    source TEXT CHECK (source IN ('voice', 'text')),
    model TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_session_created
    ON messages(session_id, created_at);
`);

logger.info({ dbPath }, 'sqlite ready');

const stmts = {
  upsertSession: db.prepare(
    `INSERT OR IGNORE INTO sessions (id, created_at) VALUES (?, ?)`,
  ),
  insertMessage: db.prepare(
    `INSERT INTO messages (id, session_id, role, content, source, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ),
  listMessages: db.prepare(
    `SELECT role, content FROM messages WHERE session_id = ? ORDER BY created_at ASC`,
  ),
};

export function ensureSession(sessionId: string): void {
  stmts.upsertSession.run(sessionId, Date.now());
}

export function appendUserMessage(
  sessionId: string,
  content: string,
  source: 'voice' | 'text',
): string {
  const id = randomUUID();
  stmts.insertMessage.run(id, sessionId, 'user', content, source, null, Date.now());
  return id;
}

export function appendAssistantMessage(
  sessionId: string,
  content: string,
  model: string,
): string {
  const id = randomUUID();
  stmts.insertMessage.run(id, sessionId, 'assistant', content, null, model, Date.now());
  return id;
}

export function loadHistory(
  sessionId: string,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  return stmts.listMessages.all(sessionId) as Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
}
