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
  const fake = vi.fn(async (_input: string | URL | Request) =>
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
