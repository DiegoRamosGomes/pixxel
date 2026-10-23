import { afterEach, describe, expect, it, vi } from 'vitest';

describe('config', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('GEMINI_LIVE_MODEL vazio (como no .env.example) usa o modelo padrão', async () => {
    vi.stubEnv('CLIENT_TOKEN', 'token-de-teste-123');
    vi.stubEnv('GEMINI_LIVE_MODEL', '');
    const { config } = await import('./config.js');
    expect(config.GEMINI_LIVE_MODEL).toBeUndefined();
  });

  it('GEMINI_LIVE_MODEL preenchido é respeitado', async () => {
    vi.stubEnv('CLIENT_TOKEN', 'token-de-teste-123');
    vi.stubEnv('GEMINI_LIVE_MODEL', 'models/gemini-2.5-flash-native-audio-latest');
    const { config } = await import('./config.js');
    expect(config.GEMINI_LIVE_MODEL).toBe('models/gemini-2.5-flash-native-audio-latest');
  });
});
