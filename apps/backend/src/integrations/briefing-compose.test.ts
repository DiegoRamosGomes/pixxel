import { describe, expect, it } from 'vitest';
import { normalizeSpeech } from '@assistant/shared/briefing-cues';
import { composeBriefing, type BriefingInput } from './briefing-compose.js';
import type { NewsItem } from './news.js';

const weather = {
  kind: 'weather' as const,
  when: 'today' as const,
  city: 'Jaguaruna',
  tempC: 21.6,
  condition: 'parcialmente nublado',
  weatherCode: 2,
  minC: 17.2,
  maxC: 26.4,
  rainPercent: 10,
};

function item(area: NewsItem['area'], title: string, n: number): NewsItem {
  return {
    area,
    title,
    summary: `Resumo ${n}`,
    url: `https://exemplo.com/${n}`,
    source: 'g1',
    publishedAt: '2026-10-23T10:00:00.000Z',
  };
}

const news: NewsItem[] = [
  item('mundo', 'Cúpula define novo acordo climático.', 1),
  item('tecnologia', 'Nova versão do chip é anunciada', 2),
  item('economia', 'Dólar fecha em queda!', 3),
];

const base: BriefingInput = {
  greeting: 'Bom dia, senhor.',
  dateLine: 'Hoje é sexta-feira, 23 de outubro de 2026.',
  weekday: 'sexta-feira',
  day: 23,
  monthYear: 'outubro de 2026',
  observance: null,
  weather,
  news,
};

describe('composeBriefing', () => {
  it('completo: data, clima e três notícias', () => {
    const r = composeBriefing(base);
    expect(r.widget.segments.map((s) => s.kind)).toEqual(['date', 'weather', 'news', 'news', 'news']);
    expect(r.text.endsWith('Quer que eu abra alguma delas?')).toBe(true);
    expect(r.text).toContain(
      'Em Jaguaruna, agora faz 22 graus, parcialmente nublado. Mínima de 17 e máxima de 26, com 10% de chance de chuva.',
    );
    expect(r.text).toContain('No mundo, Cúpula define novo acordo climático.');
    expect(r.text).toContain('Na tecnologia, Nova versão do chip é anunciada.');
    expect(r.text).toContain('Na economia, Dólar fecha em queda.');
    const w = r.widget.segments[1];
    expect(w.kind === 'weather' && w.place).toBe('Jaguaruna · SC');
  });

  it('deixas únicas', () => {
    const { segments } = composeBriefing(base).widget;
    expect(new Set(segments.map((s) => s.cue)).size).toBe(segments.length);
    expect(segments[0].cue).toBe('hoje e sexta feira');
  });

  it('deixa de cada trecho não aparece na fala dos trechos anteriores', () => {
    const { segments } = composeBriefing(base).widget;
    segments.forEach((s, i) => {
      const before = normalizeSpeech(segments.slice(0, i).map((p) => p.say).join(' '));
      expect(s.cue).not.toBe('');
      expect((' ' + before + ' ').includes(' ' + s.cue + ' ')).toBe(false);
    });
  });

  it('feriado: marca o card e inclui a linha na fala', () => {
    const line = 'Atenção: hoje é Proclamação da República — feriado nacional, não é dia útil.';
    const r = composeBriefing({
      ...base,
      observance: { name: 'Proclamação da República', isNationalHoliday: true, line },
    });
    const d = r.widget.segments[0];
    expect(d.kind === 'date' && d.observance).toEqual({ name: 'Proclamação da República', type: 'holiday' });
    expect(d.say).toContain(line);
    expect(d.say.startsWith('Bom dia, senhor. Hoje é')).toBe(true);
  });

  it('data comemorativa não nacional vira observance', () => {
    const r = composeBriefing({
      ...base,
      observance: { name: 'Dia X', isNationalHoliday: false, line: 'Hoje é o Dia X.' },
    });
    const d = r.widget.segments[0];
    expect(d.kind === 'date' && d.observance?.type).toBe('observance');
  });

  it('sem clima e sem notícias', () => {
    const r = composeBriefing({ ...base, weather: null, news: [] });
    expect(r.widget.segments.map((s) => s.kind)).toEqual(['date']);
    expect(r.text.endsWith('Em que posso ajudar, senhor?')).toBe(true);
    expect(r.news).toEqual([]);
  });

  it('clima sem mín/máx e sem chuva', () => {
    const semMinMax = composeBriefing({ ...base, weather: { ...weather, minC: undefined, maxC: undefined } });
    expect(semMinMax.text).toContain('parcialmente nublado. Chance de chuva de 10%.');
    const semChuva = composeBriefing({ ...base, weather: { ...weather, rainPercent: undefined } });
    expect(semChuva.text).toContain('Mínima de 17 e máxima de 26.');
  });

  it('sem tempC não há segmento de clima', () => {
    const r = composeBriefing({ ...base, weather: { ...weather, tempC: undefined } });
    expect(r.widget.segments.some((s) => s.kind === 'weather')).toBe(false);
  });

  it('news para a tool', () => {
    expect(composeBriefing(base).news).toEqual([
      { area: 'mundo', title: 'Cúpula define novo acordo climático.', url: 'https://exemplo.com/1' },
      { area: 'tecnologia', title: 'Nova versão do chip é anunciada', url: 'https://exemplo.com/2' },
      { area: 'economia', title: 'Dólar fecha em queda!', url: 'https://exemplo.com/3' },
    ]);
  });
});
