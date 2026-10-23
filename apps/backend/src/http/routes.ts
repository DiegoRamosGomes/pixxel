// Rotas HTTP pros clientes: dados que a UI pede sob demanda (grafo de
// memória) e upload de arquivo (publicação no Instagram). Autenticação por
// `Authorization: Bearer <CLIENT_TOKEN>`.

import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';


export type HttpRoutesDeps = {
  token: string;
  memoryGraph(): { nodes: unknown[]; edges: unknown[] };
  publishInstagram(
    bytes: Buffer,
    fileName: string,
    caption: string,
    shareToFeed: boolean,
  ): Promise<{ ok: boolean; reason?: string; permalink?: string }>;
};

const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;

// Genérico no logger: o server usa pino, que tem tipo próprio.
export function registerHttpRoutes<L extends FastifyBaseLogger>(
  app: FastifyInstance<Server, IncomingMessage, ServerResponse, L>,
  deps: HttpRoutesDeps,
): void {
  const authed = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (req.headers.authorization === `Bearer ${deps.token}`) return true;
    void reply.code(401).send({ error: 'unauthorized' });
    return false;
  };

  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body),
  );

  app.get('/api/memory-graph', async (req, reply) => {
    if (!authed(req, reply)) return reply;
    return deps.memoryGraph();
  });

  app.post('/api/instagram/publish', { bodyLimit: MAX_UPLOAD_BYTES }, async (req, reply) => {
    if (!authed(req, reply)) return reply;
    const header = (name: string): string => {
      const v = req.headers[name];
      return typeof v === 'string' ? v : '';
    };
    const fileName = header('x-file-name') || 'upload.bin';
    const caption = decodeURIComponent(header('x-caption'));
    const shareToFeed = header('x-share-to-feed') === 'true';
    const bytes = req.body as Buffer;
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      return reply.code(400).send({ ok: false, reason: 'arquivo vazio' });
    }
    return deps.publishInstagram(bytes, fileName, caption, shareToFeed);
  });
}
