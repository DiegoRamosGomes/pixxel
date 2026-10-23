// Pasta onde a API guarda memória, planos de estudo, registros de trabalho e
// estado das integrações. Em dev é ~/pixxel; no Docker aponta pro volume.

import { homedir } from 'node:os';
import { join } from 'node:path';

export function dataDir(): string {
  return process.env.PIXXEL_DATA_DIR || join(homedir(), 'pixxel');
}

export function dataPath(...segments: string[]): string {
  return join(dataDir(), ...segments);
}
