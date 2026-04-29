/**
 * Acumula chunks do LLM e libera "pedaços faláveis" pro TTS.
 *
 * Estratégia:
 *  - Primeira fatia: emite o mais cedo possível pra reduzir latência percebida.
 *    Considera "fala-cedo" qualquer separador (vírgula/ponto/dois-pontos) com
 *    ao menos `FIRST_MIN_LEN` chars, ou `FIRST_MAX_NO_BREAK` chars sem nada.
 *  - Próximas: acumula até pelo menos `MIN_FOLLOWUP_LEN` chars E fim de frase,
 *    ou quebra dura (`\n\n`). Reduz spawns do piper.
 *  - flush() drena tudo que sobrou.
 */

const SENTENCE_END_RE = /[.!?…]/g;
const SOFT_BREAK_RE = /[,;:]/g;
const FIRST_MIN_LEN = 30;
const FIRST_MAX_NO_BREAK = 80;
const MIN_FOLLOWUP_LEN = 120;

export class SentenceBuffer {
  private buffer = '';
  private firstSent = false;

  push(chunk: string): string[] {
    this.buffer += chunk;
    const out: string[] = [];

    while (true) {
      // Quebra dura sempre é fronteira.
      const hardIdx = this.buffer.indexOf('\n\n');
      if (hardIdx >= 0) {
        const part = this.buffer.slice(0, hardIdx).trim();
        if (part) {
          out.push(part);
          this.firstSent = true;
        }
        this.buffer = this.buffer.slice(hardIdx + 2);
        continue;
      }

      if (!this.firstSent) {
        // Primeira fala: agressiva. Emite no primeiro separador útil.
        const cut = this.findFirstCut();
        if (cut == null) break;
        const part = this.buffer.slice(0, cut + 1).trim();
        if (part) {
          out.push(part);
          this.firstSent = true;
        }
        this.buffer = this.buffer.slice(cut + 1).replace(/^\s+/, '');
        continue;
      }

      // Próximas: só fim de frase + mínimo.
      const m = this.findSentenceEndAfter(0);
      if (m == null) break;
      const candidate = this.buffer.slice(0, m + 1);
      const trimmed = candidate.trim();

      if (trimmed.length >= MIN_FOLLOWUP_LEN) {
        out.push(trimmed);
        this.buffer = this.buffer.slice(m + 1).replace(/^\s+/, '');
        continue;
      }

      // Não atingiu mínimo — tenta a próxima pontuação se houver mais buffer.
      const next = this.findSentenceEndAfter(m + 1);
      if (next == null) break;
      const longer = this.buffer.slice(0, next + 1);
      if (longer.trim().length >= MIN_FOLLOWUP_LEN) {
        out.push(longer.trim());
        this.buffer = this.buffer.slice(next + 1).replace(/^\s+/, '');
        continue;
      }
      break;
    }

    return out;
  }

  private findFirstCut(): number | null {
    // 1. Fim de frase (ponto/exclamação) confirma logo, sem mínimo.
    const sentEnd = this.findSentenceEndAfter(0);
    if (sentEnd != null) return sentEnd;

    // 2. Separador suave (vírgula, ponto-vírgula, dois-pontos) com mínimo.
    SOFT_BREAK_RE.lastIndex = 0;
    let softMatch: RegExpExecArray | null;
    while ((softMatch = SOFT_BREAK_RE.exec(this.buffer))) {
      const idx = softMatch.index;
      const next = this.buffer[idx + 1];
      if (next === undefined || /\s/.test(next)) {
        if (idx + 1 >= FIRST_MIN_LEN) return idx;
      }
    }

    // 3. Limite de chars sem qualquer separador — emite no último espaço.
    if (this.buffer.length >= FIRST_MAX_NO_BREAK) {
      const lastSpace = this.buffer.lastIndexOf(' ', FIRST_MAX_NO_BREAK);
      if (lastSpace > 0) return lastSpace - 1;
      return FIRST_MAX_NO_BREAK - 1;
    }

    return null;
  }

  private findSentenceEndAfter(start: number): number | null {
    SENTENCE_END_RE.lastIndex = start;
    let m: RegExpExecArray | null;
    while ((m = SENTENCE_END_RE.exec(this.buffer))) {
      const idx = m.index;
      const next = this.buffer[idx + 1];
      if (next === undefined || /\s/.test(next) || next === '\n') {
        return idx;
      }
    }
    return null;
  }

  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = '';
    this.firstSent = false;
    return rest || null;
  }

  reset(): void {
    this.buffer = '';
    this.firstSent = false;
  }
}
