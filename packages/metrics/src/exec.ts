// Roda comandos de sistema com locale neutro. No Mac em pt-BR o `ps` sai
// com vírgula decimal ("63,9") — LC_ALL=C padroniza pra ponto.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function run(cmd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(cmd, args, {
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 10_000,
  });
  return stdout;
}
