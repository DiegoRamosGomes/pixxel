// IMAP client pra Gmail. Usa GMAIL_USER + GMAIL_APP_PASS do .env.
// Read-write: lista unread, aplica label "IA/Importante" ou "IA/NaoImportante",
// marca como lido. Watermark por UID pra não reprocessar.

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

export const LABEL_IMPORTANT = 'IA/Importante';
export const LABEL_NOT_IMPORTANT = 'IA/NaoImportante';

export type EmailMessage = {
  uid: number;
  from: string;
  subject: string;
  date: Date | null;
  snippet: string;
  text: string;
};

export const isGmailAvailable = (): boolean =>
  Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASS);

function buildClient(): ImapFlow {
  const user = process.env.GMAIL_USER;
  const pass = (process.env.GMAIL_APP_PASS || '').replace(/\s+/g, '');
  if (!user || !pass) {
    throw new Error('GMAIL_USER e GMAIL_APP_PASS precisam estar no .env');
  }
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
}

function formatAddress(addr: { name?: string; address?: string } | undefined): string {
  if (!addr) return '';
  const name = (addr.name || '').trim();
  const address = addr.address || '';
  return name ? `${name} <${address}>` : address;
}

/**
 * Fetch dos últimos N emails da INBOX, lidos ou não. Usa pra backfill
 * (indexar histórico). Não toca em labels nem flags — só leitura.
 */
export async function fetchRecent(limit: number): Promise<EmailMessage[]> {
  const client = buildClient();
  await client.connect();
  const out: EmailMessage[] = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    const status = await client.status('INBOX', { messages: true });
    const total = status.messages ?? 0;
    if (total === 0) return out;
    const start = Math.max(1, total - limit + 1);
    const range = `${start}:${total}`;

    for await (const msg of client.fetch(
      range,
      { uid: true, envelope: true, internalDate: true, source: true },
    )) {
      const parsed = await simpleParser(msg.source as Buffer);
      const text = (parsed.text || '').trim();
      out.push({
        uid: msg.uid,
        from: formatAddress(msg.envelope?.from?.[0]),
        subject: msg.envelope?.subject || '(sem assunto)',
        date: msg.internalDate ? new Date(msg.internalDate) : null,
        snippet: text.replace(/\s+/g, ' ').slice(0, 300),
        text,
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
}

export async function fetchUnread(opts: {
  limit?: number;
  sinceUid?: number;
} = {}): Promise<EmailMessage[]> {
  const limit = opts.limit ?? 50;
  const sinceUid = opts.sinceUid ?? 0;
  const client = buildClient();
  await client.connect();
  const out: EmailMessage[] = [];
  const lock = await client.getMailboxLock('INBOX');
  try {
    let uids = ((await client.search({ seen: false }, { uid: true })) as number[]) || [];
    if (sinceUid > 0) uids = uids.filter((u) => u > sinceUid);
    const recent = uids.slice(-limit);
    if (recent.length === 0) return out;

    for await (const msg of client.fetch(
      recent,
      { uid: true, envelope: true, internalDate: true, source: true },
      { uid: true },
    )) {
      const parsed = await simpleParser(msg.source as Buffer);
      const text = (parsed.text || '').trim();
      out.push({
        uid: msg.uid,
        from: formatAddress(msg.envelope?.from?.[0]),
        subject: msg.envelope?.subject || '(sem assunto)',
        date: msg.internalDate ? new Date(msg.internalDate) : null,
        snippet: text.replace(/\s+/g, ' ').slice(0, 300),
        text,
      });
    }
  } finally {
    lock.release();
    await client.logout();
  }
  return out;
}

async function ensureLabel(client: ImapFlow, label: string): Promise<void> {
  try {
    await client.mailboxCreate(label);
  } catch (err: unknown) {
    const e = err as { responseStatus?: string; message?: string };
    if (e.responseStatus !== 'NO' && !/already exists/i.test(e.message || '')) {
      throw err;
    }
  }
}

export async function applyLabelsAndMarkRead(
  items: Array<{ uid: number; important: boolean }>,
): Promise<void> {
  if (items.length === 0) return;
  const importantUids = items.filter((i) => i.important).map((i) => i.uid);
  const notImportantUids = items.filter((i) => !i.important).map((i) => i.uid);

  const client = buildClient();
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    if (importantUids.length > 0) {
      await ensureLabel(client, LABEL_IMPORTANT);
      await client.messageCopy(importantUids, LABEL_IMPORTANT, { uid: true });
      await client.messageFlagsAdd(importantUids, ['\\Seen'], { uid: true });
    }
    if (notImportantUids.length > 0) {
      await ensureLabel(client, LABEL_NOT_IMPORTANT);
      await client.messageCopy(notImportantUids, LABEL_NOT_IMPORTANT, { uid: true });
      await client.messageFlagsAdd(notImportantUids, ['\\Seen'], { uid: true });
    }
  } finally {
    lock.release();
    await client.logout();
  }
}
