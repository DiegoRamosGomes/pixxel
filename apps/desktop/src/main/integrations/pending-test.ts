// Persistência de "teste pendente pós-restart". Quando o Gemini chama
// restart_app passando test_plan, gravamos aqui antes de relançar. No boot
// seguinte, se --auto-test estiver no argv, lemos esse arquivo, dispachamos
// um claude_code_task pra validar, e apagamos. Sobrevive ao restart porque
// o processo morre — não dá pra carregar em memória.

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FILE = join(homedir(), 'pixxel', 'pending-test.json');

export interface PendingTest {
  testPlan: string;
  projectPath: string;
  projectName: string | null;
  createdAt: string;
}

export async function savePendingTest(p: Omit<PendingTest, 'createdAt'>): Promise<void> {
  await mkdir(join(homedir(), 'pixxel'), { recursive: true });
  const payload: PendingTest = { ...p, createdAt: new Date().toISOString() };
  await writeFile(FILE, JSON.stringify(payload, null, 2), 'utf8');
}

export async function readPendingTest(): Promise<PendingTest | null> {
  if (!existsSync(FILE)) return null;
  try {
    const raw = await readFile(FILE, 'utf8');
    const parsed = JSON.parse(raw) as PendingTest;
    if (!parsed.testPlan || !parsed.projectPath) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function clearPendingTest(): Promise<void> {
  if (!existsSync(FILE)) return;
  try {
    await unlink(FILE);
  } catch {
    // ignore
  }
}
