import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerHttpRoutes } from './routes.js';

let app: FastifyInstance;

async function setup() {
  app = Fastify();
  const publishInstagram = vi.fn(async () => ({ ok: true, permalink: 'https://instagram.com/p/x' }));
  registerHttpRoutes(app, {
    token: 'tok-123456',
    memoryGraph: () => ({ nodes: [{ id: 'a' }], edges: [] }),
    publishInstagram,
  });
  await app.ready();
  return { publishInstagram };
}

describe('rotas HTTP', () => {
  afterEach(async () => {
    await app?.close();
  });

  it('memory-graph exige bearer', async () => {
    await setup();
    const no = await app.inject({ method: 'GET', url: '/api/memory-graph' });
    expect(no.statusCode).toBe(401);
    expect(no.json()).toEqual({ error: 'unauthorized' });
    const yes = await app.inject({
      method: 'GET',
      url: '/api/memory-graph',
      headers: { authorization: 'Bearer tok-123456' },
    });
    expect(yes.statusCode).toBe(200);
    expect(yes.json()).toEqual({ nodes: [{ id: 'a' }], edges: [] });
  });

  it('publica arquivo no Instagram com os headers', async () => {
    const { publishInstagram } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/instagram/publish',
      headers: {
        authorization: 'Bearer tok-123456',
        'content-type': 'application/octet-stream',
        'x-file-name': 'foto.jpg',
        'x-caption': encodeURIComponent('Olá, mundo'),
        'x-share-to-feed': 'true',
      },
      payload: Buffer.from([1, 2, 3]),
    });
    expect(res.json()).toEqual({ ok: true, permalink: 'https://instagram.com/p/x' });
    expect(publishInstagram).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), 'foto.jpg', 'Olá, mundo', true);
  });
});
