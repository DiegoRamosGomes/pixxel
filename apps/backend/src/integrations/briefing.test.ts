import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WeatherWidget } from '@assistant/shared/widgets';
import type { NewsItem } from './news.js';
import { BRIEFING_FETCH_BUDGET_MS, buildMorningBriefing } from './briefing.js';

const NOW = new Date('2026-10-23T10:00:00-03:00');

const weather: WeatherWidget = {
  kind: 'weather',
  city: 'Jaguaruna',
  tempC: 24,
  condition: 'céu limpo',
  weatherCode: 0,
  minC: 18,
  maxC: 27,
  rainPercent: 10,
} as WeatherWidget;

function item(area: NewsItem['area'], n: number): NewsItem {
  return {
    area,
    title: `Manchete ${n}.`,
    summary: `Resumo ${n}`,
    url: `https://exemplo.com/${n}`,
    source: 'g1',
    publishedAt: '2026-10-23T08:00:00-03:00',
  };
}

const news = [item('mundo', 1), item('tecnologia', 2), item('economia', 3)];

function deps(over: Record<string, unknown> = {}) {
  return {
    now: () => NOW,
    fetchWeather: async () => weather,
    fetchNews: async () => news,
    fetchHolidays: async () => [],
    ...over,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('buildMorningBriefing', () => {
  it('ordem e meta', async () => {
    const r = await buildMorningBriefing(deps());
    const w = r.widgets[0];
    expect(w.kind).toBe('briefing');
    if (w.kind !== 'briefing') throw new Error('widget inesperado');
    expect(w.segments.map((s) => s.kind)).toEqual(['date', 'weather', 'news', 'news', 'news']);
    expect(r.meta.news).toHaveLength(3);
    expect(r.meta.holiday).toBeNull();
    expect(r.widgetDelaysMs).toEqual([0]);
    expect(r.text.startsWith('Bom dia, senhor.')).toBe(true);
  });

  it('clima falha', async () => {
    const r = await buildMorningBriefing(
      deps({ fetchWeather: async () => { throw new Error('boom'); } }),
    );
    const w = r.widgets[0];
    if (w.kind !== 'briefing') throw new Error('widget inesperado');
    expect(w.segments.map((s) => s.kind)).toEqual(['date', 'news', 'news', 'news']);
  });

  it('orçamento', async () => {
    vi.useFakeTimers();
    const p = buildMorningBriefing(deps({ fetchNews: () => new Promise(() => {}) }));
    await vi.advanceTimersByTimeAsync(BRIEFING_FETCH_BUDGET_MS);
    const r = await p;
    expect(r.meta.news).toEqual([]);
    expect(r.text.endsWith('Em que posso ajudar, senhor?')).toBe(true);
  });

  it('sem ClickUp', async () => {
    const r = await buildMorningBriefing(deps());
    expect(r.text).not.toContain('tarefa');
    expect(r.text).not.toContain('Disco');
  });

  it('fetch do Nager.Date tem timeout de 3,5 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fake = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify([{ date: '2026-10-23', localName: 'Dia Real', global: true }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fake);

    const r = await buildMorningBriefing(deps({ fetchHolidays: undefined }));

    expect(String(fake.mock.calls[0][0])).toContain('date.nager.at');
    expect(timeout).toHaveBeenCalledWith(3500);
    expect(fake.mock.calls[0][1]?.signal).toBe(timeout.mock.results[0].value);
    expect(r.meta.holiday).toEqual({ name: 'Dia Real', isNationalHoliday: true });
  });

  it('timeout do Nager.Date segue sem feriado', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );

    // Outro ano, pra não pegar o cache de feriados do teste anterior.
    const r = await buildMorningBriefing(
      deps({ now: () => new Date('2027-10-22T10:00:00-03:00'), fetchHolidays: undefined }),
    );

    expect(r.meta.holiday).toBeNull();
    expect(r.text.startsWith('Bom dia, senhor.')).toBe(true);
  });

  it('feriado vem das deps injetadas', async () => {
    const r = await buildMorningBriefing(
      deps({ fetchHolidays: async () => [{ date: '2026-10-23', name: 'Dia Teste', optional: false }] }),
    );
    expect(r.meta.holiday).toEqual({ name: 'Dia Teste', isNationalHoliday: true });
    expect(r.text).toContain('Dia Teste');
  });
});
