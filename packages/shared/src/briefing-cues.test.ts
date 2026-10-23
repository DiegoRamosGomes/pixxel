import { describe, expect, it } from 'vitest';
import { cueHeard, makeCue, normalizeSpeech } from './briefing-cues.js';

describe('normalizeSpeech', () => {
  it('tira acentos, pontuação e caixa', () => {
    expect(normalizeSpeech('Hoje é Sexta-feira, 23 de outubro!')).toBe('hoje e sexta feira 23 de outubro');
    expect(normalizeSpeech('  Na   ECONOMIA,\n dólar  ')).toBe('na economia dolar');
  });
});

describe('makeCue', () => {
  it('pega as primeiras palavras normalizadas', () => {
    expect(makeCue('Hoje é sexta-feira, 23 de outubro de 2026.')).toBe('hoje e sexta feira');
    expect(makeCue('Em Jaguaruna, agora faz 22 graus')).toBe('em jaguaruna agora faz');
  });
  it('pula token com dígito', () => {
    expect(makeCue('No mundo, 5 países assinam acordo')).toBe('no mundo paises assinam');
  });
});

describe('cueHeard', () => {
  it('acha o cue no meio da fala', () => {
    expect(cueHeard('…e agora, no mundo, países assinam acordo', 'no mundo paises assinam')).toBe(true);
    expect(cueHeard('minha economia', 'economia')).toBe(true);
  });
  it('exige palavras inteiras', () => {
    expect(cueHeard('no mundo paisesassinam', 'no mundo paises assinam')).toBe(false);
    expect(cueHeard('microeconomia', 'economia')).toBe(false);
  });
});
