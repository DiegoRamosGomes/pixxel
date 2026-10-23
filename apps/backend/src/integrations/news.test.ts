import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchNews, parseRss, pickNews, type FeedItem, type NewsFeeds } from './news.js';

const wrap = (items: string) =>
  `<?xml version="1.0"?><rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Feed</title>${items}</channel></rss>`;

const G1_ITEM = `<item><title>Microsoft diz que sua IA superou médicos em testes de diagnóstico</title>
<atom:subtitle>Segundo a empresa, ferramenta foi mais de duas vezes mais precisa que médicos generalistas.</atom:subtitle>
<link>https://g1.globo.com/tecnologia/noticia/2026/10/23/microsoft-diz-que.ghtml</link>
<description><![CDATA[ <img src="https://s2-g1.glbimg.com/abc.jpg" /><br /> ]]> Microsoft diz que…
REUTERS/Dado Ruvic/Ilustração
Pesquisadores da Microsoft afirmam…</description>
<media:content url="https://s2-g1.glbimg.com/abc.jpg" medium="image"/>
<pubDate>Fri, 23 Oct 2026 14:16:03 -0000</pubDate></item>`;

describe('parseRss', () => {
  it('parse g1', () => {
    const items = parseRss(wrap(G1_ITEM), 'g1');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      title: 'Microsoft diz que sua IA superou médicos em testes de diagnóstico',
      url: 'https://g1.globo.com/tecnologia/noticia/2026/10/23/microsoft-diz-que.ghtml',
      summary:
        'Segundo a empresa, ferramenta foi mais de duas vezes mais precisa que médicos generalistas.',
      imageUrl: 'https://s2-g1.glbimg.com/abc.jpg',
      source: 'g1',
    });
    expect(items[0].publishedAt?.toISOString()).toBe('2026-10-23T14:16:03.000Z');
  });

  it('g1 sem subtítulo: resumo sem legenda nem crédito da foto', () => {
    const xml = wrap(`<item><title>Microsoft diz que sua IA superou médicos em testes de diagnóstico</title>
<link>https://g1.globo.com/tecnologia/noticia/2026/10/23/microsoft-diz-que.ghtml</link>
<description><![CDATA[ <img src="https://s2-g1.glbimg.com/abc.jpg" /><br /> ]]> Microsoft diz que sua IA superou médicos em testes de diagnóstico
REUTERS/Dado Ruvic/Ilustração
Pesquisadores da Microsoft afirmam que a ferramenta acertou mais diagnósticos que médicos generalistas.</description>
<pubDate>Fri, 23 Oct 2026 14:16:03 -0000</pubDate></item>`);
    const [g1] = parseRss(xml, 'g1');
    expect(g1.summary.startsWith('Pesquisadores da Microsoft afirmam')).toBe(true);
    expect(g1.summary).toBe(
      'Pesquisadores da Microsoft afirmam que a ferramenta acertou mais diagnósticos que médicos generalistas.',
    );
  });

  it('descarta crédito "Foto de arquivo" e "Divulgação" no resumo de reserva', () => {
    const xml = (credit: string) =>
      wrap(`<item><title>Selic é mantida</title><link>https://g1.globo.com/a</link>
<description>Selic é mantida!
${credit}
Texto do resumo.</description></item>`);
    expect(parseRss(xml('Banco Central — Foto de arquivo'), 'g1')[0].summary).toBe('Texto do resumo.');
    expect(parseRss(xml('Foto: Divulgação'), 'g1')[0].summary).toBe('Texto do resumo.');
    // Linha longa ou com ponto final é texto, não crédito.
    expect(parseRss(xml('Juros ficam em 15% a/a.'), 'g1')[0].summary).toBe('Juros ficam em 15% a/a.');
  });

  it('parse olhar', () => {
    const xml = wrap(`<item><title>Notícia do Olhar</title>
<link>https://olhardigital.com.br/2026/10/23/noticia/</link>
<description><![CDATA[<p>Resumo limpo</p> <p>O post <a href="https://olhardigital.com.br/x">Notícia</a> apareceu primeiro em Olhar Digital.</p>]]></description>
<content:encoded><![CDATA[<p><img width="800" src="https://olhardigital.com.br/wp-content/uploads/a.jpg" alt="x" /></p><p>Texto</p>]]></content:encoded>
<pubDate>Fri, 23 Oct 2026 10:00:00 +0000</pubDate></item>`);
    const [item] = parseRss(xml, 'Olhar Digital');
    expect(item.summary).toBe('Resumo limpo');
    expect(item.imageUrl).toBe('https://olhardigital.com.br/wp-content/uploads/a.jpg');
  });

  it('entidades e CDATA', () => {
    const xml = wrap(
      `<item><title><![CDATA[Governo &quot;estuda&quot; &#8220;recarga&#8221; &amp; tarifa]]></title><link>https://x.com/a</link></item>`,
    );
    expect(parseRss(xml, 'g1')[0].title).toBe('Governo "estuda" “recarga” & tarifa');
  });

  it('decodifica entidades hexadecimais e apóstrofo', () => {
    const xml = wrap(
      `<item><title>A&#x27;B &lt;C&gt; D&apos;E</title><link>https://x.com/a</link></item>`,
    );
    expect(parseRss(xml, 'g1')[0].title).toBe("A'B <C> D'E");
  });

  it('resumo longo', () => {
    const longo = 'palavra '.repeat(40).trim();
    const xml = wrap(
      `<item><title>T</title><link>https://x.com/a</link><atom:subtitle>${longo}</atom:subtitle></item>`,
    );
    const { summary } = parseRss(xml, 'g1')[0];
    expect(summary.length).toBeLessThanOrEqual(141);
    expect(summary.endsWith('…')).toBe(true);
    expect(summary.slice(0, -1).endsWith('palavra')).toBe(true);
  });

  it('usa só a primeira frase quando cabe', () => {
    const xml = wrap(
      `<item><title>T</title><link>https://x.com/a</link><atom:subtitle>Primeira frase. Segunda frase.</atom:subtitle></item>`,
    );
    expect(parseRss(xml, 'g1')[0].summary).toBe('Primeira frase.');
  });

  it('sem pubDate', () => {
    const xml = wrap(`<item><title>T</title><link>https://x.com/a</link></item>`);
    const [item] = parseRss(xml, 'g1');
    expect(item.publishedAt).toBeNull();
    expect(item.imageUrl).toBeUndefined();
  });

  it('XML inválido ou vazio', () => {
    expect(parseRss('', 'g1')).toEqual([]);
    expect(parseRss('<rss><channel><item><title>sem fim', 'g1')).toEqual([]);
    expect(parseRss('não é xml', 'g1')).toEqual([]);
  });
});

const NOW = new Date('2026-10-23T12:00:00Z');
const ago = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const item = (over: Partial<FeedItem> & { title: string; url: string }): FeedItem => ({
  summary: 'resumo',
  publishedAt: ago(1),
  source: 'g1',
  ...over,
});
const feeds = (over: Partial<NewsFeeds> = {}): NewsFeeds => ({
  mundo: [],
  economia: [],
  tecnologia: [],
  tecnologiaReserva: [],
  ...over,
});

describe('pickNews', () => {
  it('PHP vence produto', () => {
    const result = pickNews(
      feeds({
        tecnologia: [
          item({ title: 'Brecha no PHP tira sites do ar', url: 'https://g1.globo.com/tecnologia/a', publishedAt: ago(3) }),
          item({ title: 'Novo celular dobrável chega ao Brasil', url: 'https://g1.globo.com/tecnologia/b', publishedAt: ago(1) }),
        ],
      }),
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Brecha no PHP tira sites do ar');
  });

  it('oferta desce', () => {
    const result = pickNews(
      feeds({
        tecnologia: [
          item({ title: 'Ofertas tech: monitor com 40% OFF', url: 'https://g1.globo.com/tecnologia/a', publishedAt: ago(1) }),
          item({ title: 'Apple lança chip', url: 'https://g1.globo.com/tecnologia/b', publishedAt: ago(5) }),
        ],
      }),
      NOW,
    );
    expect(result[0].title).toBe('Apple lança chip');
  });

  it('oferta no plural também desce', () => {
    const contra = (title: string) =>
      pickNews(
        feeds({
          tecnologia: [
            item({ title, url: 'https://g1.globo.com/tecnologia/a', publishedAt: ago(1) }),
            item({ title: 'Apple lança chip', url: 'https://g1.globo.com/tecnologia/b', publishedAt: ago(5) }),
          ],
        }),
        NOW,
      )[0].title;
    expect(contra('Veja promoções de fones')).toBe('Apple lança chip');
    expect(contra('Veja cupons de desconto')).toBe('Apple lança chip');
    expect(contra('Cupons para fones')).toBe('Apple lança chip');
    expect(contra('Fones imperdíveis')).toBe('Apple lança chip');
  });

  it('sem repetida entre áreas', () => {
    const php = item({ title: 'Brecha no PHP tira sites do ar', url: 'https://g1.globo.com/tecnologia/php' });
    const result = pickNews(
      feeds({
        tecnologia: [php],
        mundo: [php, item({ title: 'Cúpula termina', url: 'https://g1.globo.com/mundo/x', publishedAt: ago(2) })],
        economia: [php, item({ title: 'Dólar fecha em queda', url: 'https://g1.globo.com/economia/y', publishedAt: ago(2) })],
      }),
      NOW,
    );
    expect(result.filter((n) => n.url === php.url).map((n) => n.area)).toEqual(['tecnologia']);
    expect(result.map((n) => n.title)).toEqual([
      'Cúpula termina',
      'Brecha no PHP tira sites do ar',
      'Dólar fecha em queda',
    ]);
  });

  it('sem repetida por título normalizado', () => {
    const result = pickNews(
      feeds({
        tecnologia: [item({ title: 'Brecha no PHP!', url: 'https://a.com/1' })],
        mundo: [item({ title: 'brecha no php', url: 'https://b.com/2' })],
      }),
      NOW,
    );
    expect(result.map((n) => n.area)).toEqual(['tecnologia']);
  });

  it('editoria certa', () => {
    const result = pickNews(
      feeds({
        economia: [
          item({ title: 'Carro novo', url: 'https://g1.globo.com/carros/noticia/a', publishedAt: ago(1) }),
          item({ title: 'Selic mantida', url: 'https://g1.globo.com/economia/noticia/b', publishedAt: ago(4) }),
        ],
      }),
      NOW,
    );
    expect(result[0].url).toContain('/economia/');
  });

  it('janela', () => {
    const old = (h: number) => [item({ title: 'Velha', url: 'https://g1.globo.com/mundo/a', publishedAt: ago(h) })];
    expect(pickNews(feeds({ mundo: old(30) }), NOW).map((n) => n.area)).toEqual(['mundo']);
    expect(pickNews(feeds({ mundo: old(60) }), NOW)).toEqual([]);
  });

  it('prefere a janela de 24 h quando há item nela', () => {
    const result = pickNews(
      feeds({
        mundo: [
          item({ title: 'Velha', url: 'https://g1.globo.com/mundo/a', publishedAt: ago(30), imageUrl: 'https://i/a.jpg' }),
          item({ title: 'Nova', url: 'https://x.com/b', publishedAt: ago(20) }),
        ],
      }),
      NOW,
    );
    expect(result[0].title).toBe('Nova');
  });

  it('reserva', () => {
    const result = pickNews(
      feeds({
        tecnologiaReserva: [
          item({ title: 'Do Olhar', url: 'https://olhardigital.com.br/a', source: 'Olhar Digital' }),
        ],
      }),
      NOW,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ area: 'tecnologia', source: 'Olhar Digital' });
  });

  it('ordem de saída', () => {
    const one = (n: string) => [item({ title: n, url: `https://x.com/${n}` })];
    const result = pickNews(
      feeds({ economia: one('e'), tecnologia: one('t'), mundo: one('m') }),
      NOW,
    );
    expect(result.map((n) => n.area)).toEqual(['mundo', 'tecnologia', 'economia']);
  });
});

describe('fetchNews', () => {
  afterEach(() => vi.restoreAllMocks());

  it('isola falha', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const xml = (path: string) =>
      wrap(
        `<item><title>Notícia ${path}</title><link>https://g1.globo.com/${path}/noticia/a</link><pubDate>Fri, 23 Oct 2026 10:00:00 +0000</pubDate></item>`,
      );
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes('/economia/')) throw new Error('rede caiu');
      const path = u.includes('/mundo/') ? 'mundo' : 'tecnologia';
      return new Response(xml(path), { status: 200 });
    }) as typeof fetch;
    const result = await fetchNews(NOW, fetchImpl);
    expect(result.map((n) => n.area)).toEqual(['mundo', 'tecnologia']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[news]'), expect.anything());
  });

  it('resposta não OK vira feed vazio', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = (async () => new Response('erro', { status: 500 })) as typeof fetch;
    expect(await fetchNews(NOW, fetchImpl)).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
