// Avisos que a API gera sozinha (sem o usuário pedir): texto que o Gemini
// fala, widget pra tela e push pro celular. Os textos são os mesmos que o
// main do Electron mandava antes.

import type { Widget } from '@assistant/shared';
import { formatImportantSummary } from '../integrations/index.js';
import type { ProcessedEmail } from '../integrations/email/index.js';
import type { NotificationsBatch } from '../integrations/clickup-notifications.js';
import type { WebhookEventRow } from '../memory/db.js';

export type PushMessage = {
  title: string;
  body: string;
  priority?: 'high' | 'default';
  tags?: string[];
};

export type Notice = {
  kind: 'email' | 'clickup';
  speech: string;
  widget?: { widget: Widget; ttlMs: number };
  push?: PushMessage;
};

export function emailNotice(emails: ProcessedEmail[]): Notice {
  const summary = formatImportantSummary(emails, emails.length);
  const title =
    emails.length === 1
      ? `Email importante de ${emails[0].from.split('<')[0].trim() || 'remetente'}`
      : `${emails.length} emails importantes`;
  return {
    kind: 'email',
    speech:
      `[evento interno — não é fala do usuário] Acabou de chegar email ` +
      `importante. Avise o usuário em UMA frase curta e natural ` +
      `mencionando o(s) remetente(s). NÃO leia URLs nem detalhes ` +
      `técnicos. NÃO chame tools.\n\n${summary}`,
    push: { title, body: summary, priority: 'high', tags: ['email'] },
  };
}

export function clickupNotice(batch: NotificationsBatch): Notice {
  return {
    kind: 'clickup',
    speech:
      `[evento interno — não é fala do usuário] Notificações novas no ` +
      `ClickUp. Avise o usuário em UMA frase curta e natural usando ` +
      `EXATAMENTE o resumo abaixo (pode reformular um pouco mas não ` +
      `adicione detalhes nem chame tools).\n\n${batch.summary}`,
    widget: {
      widget: { kind: 'notifications', source: 'clickup', items: batch.items },
      ttlMs: 30 * 60_000,
    },
    push: { title: 'ClickUp', body: batch.summary },
  };
}

function expoData(row: WebhookEventRow): Record<string, unknown> {
  try {
    return JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function expoPhrase(row: WebhookEventRow): string {
  const d = expoData(row);
  const status = String(d.status ?? '');
  const platform = d.platform as 'ios' | 'android' | undefined;
  const platLabel = platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : '';
  const appLabel = typeof d.appName === 'string' ? d.appName : 'seu app';
  const target = platLabel ? ' pra ' + platLabel : '';
  switch (row.event_kind) {
    case 'expo.build.started':
      return `Build do ${appLabel}${target} começou. Pode ir se preparando pra testar.`;
    case 'expo.build.finished':
      return `Build do ${appLabel}${target} terminou com sucesso.`;
    case 'expo.build.errored':
      return `Build do ${appLabel}${target} falhou.`;
    case 'expo.build.canceled':
      return `Build do ${appLabel} foi cancelado.`;
    default:
      return `Atualização de build do ${appLabel}: ${status}.`;
  }
}

export function expoWidget(row: WebhookEventRow): { widget: Widget; ttlMs: number } {
  const d = expoData(row);
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  return {
    widget: {
      kind: 'build-status',
      provider: 'expo',
      buildId: str(d.buildId),
      appName: str(d.appName),
      platform: d.platform as 'ios' | 'android' | undefined,
      status: String(d.status ?? '') || 'unknown',
      buildUrl: str(d.buildUrl),
      artifactUrl: str(d.artifactUrl),
      receivedAt: row.received_at,
    },
    ttlMs: 60 * 60_000,
  };
}

/** Junta todas as frases de build pendentes numa única instrução pro Gemini. */
export function expoSpeech(phrases: string[]): string {
  const body =
    phrases.length === 1
      ? phrases[0]
      : `Tem ${phrases.length} novidades de build acumuladas: ` +
        phrases.map((p, i) => `${i + 1}) ${p}`).join(' ');
  return (
    `[evento interno — não é fala do usuário] Avise o usuário em frase ` +
    `natural e curta sobre os builds abaixo, sem chamar tool e sem ` +
    `adicionar detalhes. Conteúdo:\n\n${body}`
  );
}
