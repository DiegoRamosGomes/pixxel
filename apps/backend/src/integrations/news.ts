// Leitura de feeds RSS de notícias. Sem dependência de parser XML: os feeds
// que usamos (g1, Olhar Digital) são simples o bastante pra extração por regex
// sobre blocos <item>…</item>.

export type FeedItem = {
  title: string;
  url: string;
  summary: string;
  imageUrl?: string;
  publishedAt: Date | null;
  source: string;
};

const SUMMARY_MAX = 140;

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));/g, (all, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? all;
    const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
    try {
      return String.fromCodePoint(code);
    } catch {
      return all;
    }
  });
}

/** Troca `<![CDATA[x]]>` por `x`. */
function unwrapCdata(raw: string): string {
  return raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

/** Conteúdo cru da primeira ocorrência de `<tag>…</tag>` (ou null). */
function rawTag(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? m[1] : null;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Texto simples de um campo (título, link, data). */
function plainTag(block: string, tag: string): string {
  const raw = rawTag(block, tag);
  return raw === null ? '' : collapse(decodeEntities(unwrapCdata(raw)));
}

/** HTML de um campo; se veio escapado (`&lt;p&gt;`), desescapa uma vez. */
function htmlTag(block: string, tag: string): string {
  const raw = rawTag(block, tag);
  if (raw === null) return '';
  const html = unwrapCdata(raw);
  return !html.includes('<') && html.includes('&lt;') ? decodeEntities(html) : html;
}

function htmlToText(html: string): string {
  return collapse(decodeEntities(html.replace(/<[^>]*>/g, ' ')));
}

/** Primeira frase com até SUMMARY_MAX caracteres; senão corta em fim de palavra. */
function shortenSummary(text: string): string {
  if (!text) return '';
  const sentence = text.match(/^.+?[.!?](?=\s|$)/)?.[0];
  if (sentence && sentence.length <= SUMMARY_MAX) return sentence;
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX + 1);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, SUMMARY_MAX);
  return base.replace(/[\s,;:.\-–—]+$/, '') + '…';
}

function extractSummary(block: string): string {
  const subtitle = htmlToText(htmlTag(block, 'atom:subtitle'));
  if (subtitle) return shortenSummary(subtitle);
  const description = htmlTag(block, 'description');
  const firstP = description.match(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/i);
  const fromP = firstP ? htmlToText(firstP[1]) : '';
  return shortenSummary(fromP || htmlToText(description));
}

function attr(tagText: string, name: string): string | undefined {
  const m = tagText.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'));
  const value = m?.[1] ?? m?.[2];
  return value ? decodeEntities(value).trim() : undefined;
}

function extractImage(block: string): string | undefined {
  for (const m of block.matchAll(/<media:(?:content|thumbnail)\b[^>]*>/gi)) {
    const type = attr(m[0], 'type');
    const medium = attr(m[0], 'medium');
    if ((type && !type.startsWith('image/')) || (medium && medium !== 'image')) continue;
    const url = attr(m[0], 'url');
    if (url) return url;
  }
  for (const m of block.matchAll(/<enclosure\b[^>]*>/gi)) {
    if (!attr(m[0], 'type')?.startsWith('image/')) continue;
    const url = attr(m[0], 'url');
    if (url) return url;
  }
  for (const tag of ['description', 'content:encoded']) {
    const img = htmlTag(block, tag).match(/<img\b[^>]*>/i);
    const url = img ? attr(img[0], 'src') : undefined;
    if (url) return url;
  }
  return undefined;
}

export function parseRss(xml: string, source: string): FeedItem[] {
  const items: FeedItem[] = [];
  try {
    for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
      const block = m[1];
      const title = plainTag(block, 'title');
      const url = plainTag(block, 'link');
      if (!title || !url) continue;
      const pub = plainTag(block, 'pubDate');
      const date = pub ? new Date(pub) : null;
      items.push({
        title,
        url,
        summary: extractSummary(block),
        imageUrl: extractImage(block),
        publishedAt: date && !Number.isNaN(date.getTime()) ? date : null,
        source,
      });
    }
  } catch {
    return [];
  }
  return items;
}
