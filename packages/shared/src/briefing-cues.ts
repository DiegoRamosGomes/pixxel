// Normalização de fala do briefing: o backend gera o "cue" de cada trecho e o
// renderer procura esse cue na transcrição ao vivo para sincronizar os cards.

// Sigla com ponto ("I.A.", "E.U.A.", "e.u.a"): duas ou mais letras seguidas de
// ponto, com a última letra podendo vir sem ponto.
const DOTTED_ACRONYM = /(?<![\p{L}\p{N}])(?:\p{L}\.){2,}\p{L}?(?![\p{L}\p{N}])/gu;

/** Minúsculas, sem acentos, só [a-z0-9] separados por um espaço. Sigla com
 *  ponto vira as letras juntas ("I.A." → "ia"), como a fala costuma sair. */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(DOTTED_ACRONYM, (sigla) => sigla.replace(/\./g, ''))
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Primeiras `words` palavras do texto falado, parando antes do primeiro token
 *  com dígito: o número pode ser lido por extenso ("cinco") ou não, e a deixa
 *  precisa de palavras contíguas para casar na transcrição. */
export function makeCue(say: string, words = 4): string {
  const tokens = normalizeSpeech(say).split(' ').filter(Boolean);
  const firstDigit = tokens.findIndex((t) => /\d/.test(t));
  return tokens
    .slice(0, firstDigit === -1 ? tokens.length : firstDigit)
    .slice(0, words)
    .join(' ');
}

/** True se o cue aparece, como palavras inteiras, no que foi ouvido. */
export function cueHeard(heardRaw: string, cue: string): boolean {
  return (' ' + normalizeSpeech(heardRaw) + ' ').includes(' ' + cue + ' ');
}
