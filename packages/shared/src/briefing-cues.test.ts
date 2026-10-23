import { describe, expect, it } from 'vitest';
import { cueHeard, makeCue, normalizeSpeech } from './briefing-cues.js';

describe('normalizeSpeech', () => {
  it('tira acentos, pontuação e caixa', () => {
    expect(normalizeSpeech('Hoje é Sexta-feira, 23 de outubro!')).toBe('hoje e sexta feira 23 de outubro');
    expect(normalizeSpeech('  Na   ECONOMIA,\n dólar  ')).toBe('na economia dolar');
  });
  it('junta siglas com ponto', () => {
    expect(normalizeSpeech('A I.A. da empresa')).toBe('a ia da empresa');
    expect(normalizeSpeech('os E.U.A. anunciam')).toBe('os eua anunciam');
    expect(normalizeSpeech('nos e.u.a')).toBe('nos eua');
  });
});

describe('makeCue', () => {
  it('pega as primeiras palavras normalizadas', () => {
    expect(makeCue('Hoje é sexta-feira, 23 de outubro de 2026.')).toBe('hoje e sexta feira');
    expect(makeCue('Em Jaguaruna, agora faz 22 graus')).toBe('em jaguaruna agora faz');
  });
  it('para antes do primeiro token com dígito', () => {
    expect(makeCue('No mundo, 5 países assinam acordo')).toBe('no mundo');
    expect(makeCue('Na economia, IPCA-15 sobe 0,3%')).toBe('na economia ipca');
  });
});

describe('cueHeard', () => {
  it('acha o cue no meio da fala', () => {
    expect(cueHeard('…e agora, no mundo, cinco países assinam acordo', 'no mundo')).toBe(true);
    expect(cueHeard('minha economia', 'economia')).toBe(true);
  });
  it('exige palavras inteiras', () => {
    expect(cueHeard('no mundo paisesassinam', 'no mundo paises assinam')).toBe(false);
    expect(cueHeard('microeconomia', 'economia')).toBe(false);
  });
  it('casa com a transcrição real de número e sigla', () => {
    expect(cueHeard('No mundo, cinco países assinam acordo', makeCue('No mundo, 5 países assinam acordo'))).toBe(true);
    expect(cueHeard('Na economia, R$ 5 bilhões…', makeCue('Na economia, R$ 5 bilhões em investimento'))).toBe(true);
    expect(
      cueHeard('Na tecnologia, a I.A. da Microsoft…', makeCue('Na tecnologia, a IA da Microsoft supera médicos')),
    ).toBe(true);
  });
});
