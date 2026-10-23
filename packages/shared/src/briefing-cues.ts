// Normalização de fala do briefing: o backend gera o "cue" de cada trecho e o
// renderer procura esse cue na transcrição ao vivo para sincronizar os cards.

/** Minúsculas, sem acentos, só [a-z0-9] separados por um espaço. */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Primeiras `words` palavras do texto falado, ignorando tokens com dígito
 *  (números costumam ser lidos por extenso e não casariam na transcrição). */
export function makeCue(say: string, words = 4): string {
  return normalizeSpeech(say)
    .split(' ')
    .filter((t) => t && !/\d/.test(t))
    .slice(0, words)
    .join(' ');
}

/** True se o cue aparece, como palavras inteiras, no que foi ouvido. */
export function cueHeard(heardRaw: string, cue: string): boolean {
  return (' ' + normalizeSpeech(heardRaw) + ' ').includes(' ' + cue + ' ');
}
