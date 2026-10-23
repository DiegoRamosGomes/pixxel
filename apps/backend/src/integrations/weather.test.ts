import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWeather } from './weather.js';

const forecast = {
  current: { temperature_2m: 24.6, weather_code: 2 },
  daily: {
    weather_code: [2, 61],
    temperature_2m_max: [28.2, 22.9],
    temperature_2m_min: [18.4, 17.1],
    precipitation_probability_max: [10, 60],
  },
};

function stubForecast() {
  const fake = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    new Response(JSON.stringify(forecast), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fake);
  return fake;
}

describe('clima', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('fetch do Open-Meteo tem timeout de 3,5 s', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fake = stubForecast();

    await fetchWeather('today');

    expect(timeout).toHaveBeenCalledWith(3500);
    const init = fake.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.signal).toBe(timeout.mock.results[0].value);
  });

  it('timeout cai no caminho de falha', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }),
    );

    const r = await fetchWeather('today');

    expect(r.widget).toBeUndefined();
    expect(r.text).toBe('Não consegui falar com o serviço de clima agora.');
  });

  it('corpo que falha na leitura também cai no caminho de falha', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('não é json', { status: 200 })));

    const r = await fetchWeather('today');

    expect(r.text).toBe('Não consegui falar com o serviço de clima agora.');
  });

  it('usa Jaguaruna fixa, sem geolocalização por IP', async () => {
    const fake = stubForecast();

    const r = await fetchWeather('today');

    expect(fake).toHaveBeenCalledTimes(1);
    const url = String(fake.mock.calls[0][0]);
    expect(url).toContain('latitude=-28.62145');
    expect(url).toContain('longitude=-49.02529');
    expect(url).toContain('timezone=America/Sao_Paulo');
    expect(url).not.toContain('ipapi');
    expect(r.text.startsWith('Em Jaguaruna')).toBe(true);
    expect(r.widget).toMatchObject({ city: 'Jaguaruna', when: 'today' });
  });

  it('previsão de amanhã também sai de Jaguaruna', async () => {
    const fake = stubForecast();

    const r = await fetchWeather('tomorrow');

    expect(fake).toHaveBeenCalledTimes(1);
    expect(r.text.startsWith('Amanhã em Jaguaruna')).toBe(true);
    expect(r.widget).toMatchObject({ city: 'Jaguaruna', when: 'tomorrow' });
  });
});
