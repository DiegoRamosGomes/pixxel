// Webhook do Expo EAS Build.
//
// Setup no Expo:
//   eas webhook:create --event BUILD --url https://<domain>/webhook/expo --secret <SECRET>
//
// Cada request vem com:
//   header  expo-signature: sha1=<hex>
//   body    JSON do evento (BUILD_FINISHED, BUILD_STARTED, etc.)
//
// Verificação: HMAC-SHA1(body_raw, secret) === sig hex.
// Importante: precisa do RAW body (não parseado), por isso registramos um
// content-type parser custom no Fastify que captura o buffer cru.

import type { FastifyReply, FastifyRequest } from 'fastify';
// FastifyInstance é parametrizado e o type do servidor difere com loggerInstance.
// Pra evitar conflito, aceitamos um shape mínimo que cobre o que usamos.
type FastifyApp = {
  addContentTypeParser: (
    contentType: string,
    opts: { parseAs: 'buffer' },
    parser: (req: FastifyRequest, body: unknown, done: (err: Error | null, body?: unknown) => void) => void,
  ) => void;
  post: (
    path: string,
    handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
  ) => unknown;
};
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { insertWebhookEvent, listPendingWebhookEvents, type WebhookEventRow } from '../memory/db.js';

type ExpoBuildPayload = {
  status?: string; // 'started' | 'finished' | 'errored' | 'canceled'
  id?: string;
  appId?: string;
  appName?: string;
  platform?: 'ios' | 'android';
  artifacts?: { buildUrl?: string; applicationArchiveUrl?: string };
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
  // outros campos vêm — ignoramos os que não usamos
};

function verifySignature(rawBody: Buffer, signatureHeader: string): boolean {
  const secret = config.EXPO_WEBHOOK_SECRET;
  if (!secret) {
    logger.warn('EXPO_WEBHOOK_SECRET não configurado — rejeitando');
    return false;
  }
  // signatureHeader vem como "sha1=<hex>"
  const m = /^sha1=([a-f0-9]+)$/i.exec(signatureHeader);
  if (!m) return false;
  const provided = Buffer.from(m[1], 'hex');
  const expected = createHmac('sha1', secret).update(rawBody).digest();
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

function classifyKind(payload: ExpoBuildPayload): string {
  // Mapeia status do Expo pra nosso event_kind. Cobre os que o usuário pediu.
  switch (payload.status) {
    case 'started':
    case 'in-queue':
    case 'in-progress':
      return 'expo.build.started';
    case 'finished':
      return 'expo.build.finished';
    case 'errored':
      return 'expo.build.errored';
    case 'canceled':
      return 'expo.build.canceled';
    default:
      return `expo.build.${payload.status ?? 'unknown'}`;
  }
}

function normalizeForRenderer(payload: ExpoBuildPayload): Record<string, unknown> {
  // Mantém só os campos que o widget precisa — payload completo pode ter
  // dezenas de KB que não interessa pro desktop.
  return {
    buildId: payload.id,
    appName: payload.appName,
    appId: payload.appId,
    platform: payload.platform,
    status: payload.status,
    buildUrl: payload.artifacts?.buildUrl,
    artifactUrl: payload.artifacts?.applicationArchiveUrl,
    createdAt: payload.createdAt,
    updatedAt: payload.updatedAt,
  };
}

export function registerExpoWebhook(
  app: FastifyApp,
  onEvent: (row: WebhookEventRow) => void,
): void {
  // Content-type parser que preserva o body cru pra HMAC. Sem isso, o Fastify
  // só entrega `req.body` parseado e perdemos o byte-exact necessário.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      try {
        const raw = body as Buffer;
        const json = raw.length > 0 ? JSON.parse(raw.toString('utf-8')) : {};
        // Anexa o raw no objeto pra rota acessar via req.rawBody (workaround).
        (json as { __raw?: Buffer }).__raw = raw;
        done(null, json);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  app.post(
    '/webhook/expo',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const sig = req.headers['expo-signature'];
      if (typeof sig !== 'string') {
        return reply.code(400).send({ error: 'missing expo-signature header' });
      }
      const body = req.body as ExpoBuildPayload & { __raw?: Buffer };
      const rawBody = body.__raw ?? Buffer.from(JSON.stringify(body));
      if (!verifySignature(rawBody, sig)) {
        logger.warn({ headers: req.headers }, 'expo webhook: bad signature');
        return reply.code(401).send({ error: 'bad signature' });
      }
      // remove __raw do payload antes de persistir
      delete body.__raw;

      const eventKind = classifyKind(body);
      const eventId = randomUUID();
      const data = normalizeForRenderer(body);

      insertWebhookEvent({
        id: eventId,
        provider: 'expo',
        eventKind,
        payload: data,
      });
      logger.info(
        { eventId, eventKind, app: body.appName, status: body.status },
        'expo webhook persisted',
      );

      // Avisos decidem: widget, fala (ou fila até uma voz ficar pronta) e push.
      const row = listPendingWebhookEvents().find((p) => p.id === eventId);
      if (row) onEvent(row);

      return reply.code(200).send({ ok: true, id: eventId });
    },
  );
}
