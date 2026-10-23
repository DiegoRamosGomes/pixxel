import { afterEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dataDir, dataPath } from './data-dir.js';

describe('pasta de dados', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('usa PIXXEL_DATA_DIR quando definido', () => {
    vi.stubEnv('PIXXEL_DATA_DIR', '/tmp/px');
    expect(dataPath('memory', 'MEMORY.md')).toBe('/tmp/px/memory/MEMORY.md');
  });

  it('cai em ~/pixxel sem a variável', () => {
    vi.stubEnv('PIXXEL_DATA_DIR', '');
    expect(dataDir()).toBe(join(homedir(), 'pixxel'));
  });
});
