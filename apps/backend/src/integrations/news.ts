// Leitura de feeds RSS de notícias. Sem dependência de parser XML: os feeds
// que usamos (g1, Olhar Digital) são simples o bastante pra extração por regex
// sobre blocos <item>…</item>.

import { normalizeSpeech } from '@assistant/shared/briefing-cues';
import type { NewsArea } from '@assistant/shared/widgets';

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

// Pontos que não fecham frase: títulos abreviados ("Dr. Silva").
const ABBREVIATIONS = new Set(['dr', 'dra', 'sr', 'sra', 'srta', 'prof', 'profa', 'eng', 'av', 'jr', 'cia', 'ltda', 'vs']);

/** Até o fim da primeira frase. Iniciais ("J.P. Morgan") e títulos não contam como fim. */
function firstSentence(text: string): string | undefined {
  for (const m of text.matchAll(/[.!?](?=\s|$)/g)) {
    const at = m.index ?? 0;
    if (m[0] === '.') {
      const word = text.slice(0, at).split(/\s/).pop() ?? '';
      if (/^(?:\p{L}\.)*\p{L}$/u.test(word) || ABBREVIATIONS.has(word.toLowerCase())) continue;
    }
    return text.slice(0, at + 1);
  }
  return undefined;
}

/** Primeira frase com até SUMMARY_MAX caracteres; senão corta em fim de palavra. */
function shortenSummary(text: string): string {
  if (!text) return '';
  const sentence = firstSentence(text);
  if (sentence && sentence.length <= SUMMARY_MAX) return sentence;
  if (text.length <= SUMMARY_MAX) return text;
  const cut = text.slice(0, SUMMARY_MAX + 1);
  const lastSpace = cut.lastIndexOf(' ');
  const base = lastSpace > 0 ? cut.slice(0, lastSpace) : cut.slice(0, SUMMARY_MAX);
  return base.replace(/[\s,;:.\-–—]+$/, '') + '…';
}

/** Linha curta de crédito da foto ("REUTERS/Fulano/Ilustração", "Foto: Divulgação"). */
function isPhotoCredit(line: string): boolean {
  if (line.length > 80 || line.endsWith('.')) return false;
  const norm = normalizeSpeech(line);
  return line.includes('/') || norm.endsWith('foto de arquivo') || norm.endsWith('divulgacao');
}

/** Texto da description sem tags. No g1 ela começa com a imagem, a legenda
 *  (igual ao título) e o crédito da foto, cada um na sua linha: separa por
 *  linha antes de colapsar os espaços e descarta essas duas. */
function descriptionText(html: string, title: string): string {
  const titleNorm = normalizeSpeech(title);
  const text = decodeEntities(html.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ' '));
  return text
    .split('\n')
    .map(collapse)
    .filter((line) => line && normalizeSpeech(line) !== titleNorm && !isPhotoCredit(line))
    .join(' ');
}

function extractSummary(block: string, title: string): string {
  const subtitle = htmlToText(htmlTag(block, 'atom:subtitle'));
  if (subtitle) return shortenSummary(subtitle);
  const description = htmlTag(block, 'description');
  const firstP = description.match(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p>/i);
  const fromP = firstP ? htmlToText(firstP[1]) : '';
  return shortenSummary(fromP || descriptionText(description, title));
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
        summary: extractSummary(block, title),
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

export type NewsItem = {
  area: NewsArea;
  title: string;
  summary: string;
  url: string;
  imageUrl?: string;
  source: string;
  publishedAt: string;
};

export type NewsFeeds = {
  mundo: FeedItem[];
  economia: FeedItem[];
  tecnologia: FeedItem[];
  tecnologiaReserva: FeedItem[];
};

export const NEWS_FETCH_TIMEOUT_MS = 3500;

const HOUR_MS = 3600_000;

// Ordem de escolha (tira repetidas) e ordem de saída (a do briefing).
const PICK_ORDER: NewsArea[] = ['tecnologia', 'economia', 'mundo'];
const OUTPUT_ORDER: NewsArea[] = ['mundo', 'tecnologia', 'economia'];

// Termos já normalizados (sem acento, minúsculos); casam como palavra inteira,
// aceitando plural simples ("falhas", "hackers").
const TECH_RELEVANT = [
  // segurança
  'vulnerabilidade', 'falha', 'brecha', 'hacker', 'ataque hacker', 'ciberataque',
  'vazamento', 'ransomware', 'malware', 'seguranca',
  // desenvolvimento
  'programacao', 'desenvolvedor', 'linguagem', 'framework', 'codigo aberto',
  'github', 'linux', 'php', 'javascript', 'python',
  // IA
  'ia', 'inteligencia artificial', 'openai', 'chatgpt', 'gemini',
].map((t) => new RegExp(`(?:^| )${t}s?(?: |$)`));

// Plural irregular ("promoções", "cupons", "imperdíveis") vai escrito na lista;
// o resto aceita o plural simples com "s".
const TECH_PROMO = [
  'oferta', 'promocao', 'promocoes', 'desconto', 'cupom', 'cupons',
  'black friday', 'imperdivel', 'imperdiveis',
].map((t) => new RegExp(`(?:^| )${t}s?(?: |$)`));

function techScore(title: string): number {
  const norm = normalizeSpeech(title);
  let score = 0;
  if (TECH_RELEVANT.some((re) => re.test(norm))) score += 3;
  if (/%\s*off/i.test(title) || TECH_PROMO.some((re) => re.test(norm))) score -= 5;
  return score;
}

function score(area: NewsArea, item: FeedItem): number {
  let s = 0;
  if (item.url.includes(`/${area}/`)) s += 2;
  if (item.imageUrl) s += 1;
  if (area === 'tecnologia') s += techScore(item.title);
  return s;
}

/** Itens com data dentro da janela; 24 h, e só se não houver nenhum, 48 h. */
function inWindow(items: FeedItem[], now: Date): FeedItem[] {
  for (const hours of [24, 48]) {
    const found = items.filter((i) => {
      if (!i.publishedAt) return false;
      const age = now.getTime() - i.publishedAt.getTime();
      return age <= hours * HOUR_MS;
    });
    if (found.length) return found;
  }
  return [];
}

/** Maior pontuação vence; empate vai para o mais recente. */
function best(area: NewsArea, items: FeedItem[]): FeedItem | undefined {
  let top: FeedItem | undefined;
  let topScore = -Infinity;
  for (const item of items) {
    const s = score(area, item);
    const newer = top && item.publishedAt!.getTime() > top.publishedAt!.getTime();
    if (s > topScore || (s === topScore && newer)) {
      top = item;
      topScore = s;
    }
  }
  return top;
}

export function pickNews(feeds: NewsFeeds, now: Date): NewsItem[] {
  const usedUrls = new Set<string>();
  const usedTitles = new Set<string>();
  const picked = new Map<NewsArea, NewsItem>();

  for (const area of PICK_ORDER) {
    const fresh = (items: FeedItem[]) =>
      inWindow(items, now).filter(
        (i) => !usedUrls.has(i.url) && !usedTitles.has(normalizeSpeech(i.title)),
      );
    let candidates = fresh(feeds[area]);
    // A reserva só entra se a tecnologia não tiver candidato.
    if (area === 'tecnologia' && candidates.length === 0) candidates = fresh(feeds.tecnologiaReserva);
    const choice = best(area, candidates);
    if (!choice) continue;
    usedUrls.add(choice.url);
    usedTitles.add(normalizeSpeech(choice.title));
    picked.set(area, {
      area,
      title: choice.title,
      summary: choice.summary,
      url: choice.url,
      imageUrl: choice.imageUrl,
      source: choice.source,
      publishedAt: choice.publishedAt!.toISOString(),
    });
  }

  return OUTPUT_ORDER.flatMap((area) => {
    const n = picked.get(area);
    return n ? [n] : [];
  });
}

const FEED_URLS = {
  mundo: 'https://g1.globo.com/rss/g1/mundo/',
  economia: 'https://g1.globo.com/rss/g1/economia/',
  tecnologia: 'https://g1.globo.com/rss/g1/tecnologia/',
  tecnologiaReserva: 'https://olhardigital.com.br/feed/',
} as const;

/** Busca um feed; erro ou resposta ruim vira lista vazia (nunca lança). */
async function fetchFeed(url: string, source: string, fetchImpl: typeof fetch): Promise<FeedItem[]> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(NEWS_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[news] ${url} respondeu ${res.status}`);
      return [];
    }
    return parseRss(await res.text(), source);
  } catch (err) {
    console.warn(`[news] falha ao ler ${url}`, err);
    return [];
  }
}

export async function fetchNews(
  now: Date = new Date(),
  fetchImpl: typeof fetch = fetch,
): Promise<NewsItem[]> {
  const [mundo, economia, tecnologia, tecnologiaReserva] = await Promise.all([
    fetchFeed(FEED_URLS.mundo, 'g1', fetchImpl),
    fetchFeed(FEED_URLS.economia, 'g1', fetchImpl),
    fetchFeed(FEED_URLS.tecnologia, 'g1', fetchImpl),
    fetchFeed(FEED_URLS.tecnologiaReserva, 'Olhar Digital', fetchImpl),
  ]);
  return pickNews({ mundo, economia, tecnologia, tecnologiaReserva }, now);
}
