import { describe, expect, it } from 'vitest';
import { parseRss } from './news.js';

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
