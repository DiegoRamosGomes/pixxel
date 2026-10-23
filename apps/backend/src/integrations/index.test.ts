import { describe, expect, it } from 'vitest';
import { INTEGRATION_NAMES } from './index.js';

describe('integrações da API', () => {
  it('nenhuma função local é tratada pela integração', () => {
    for (const n of [
      'restart_wifi',
      'open_project',
      'restart_app',
      'desktop_mouse',
      'desktop_type',
      'desktop_key',
      'storage_status',
      'look_at_camera',
    ]) {
      expect(INTEGRATION_NAMES.has(n)).toBe(false);
    }
  });
});
