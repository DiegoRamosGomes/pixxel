import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ClaudeSession, SessionStatus } from './types.js';

const STORE_PATH = join(homedir(), 'pixxel', 'sessions.json');
const HISTORY_LIMIT = 200;

interface StoreShape {
  active: ClaudeSession[];
  history: ClaudeSession[];
}

function emptyStore(): StoreShape {
  return { active: [], history: [] };
}

export class SessionStore {
  private store: StoreShape = emptyStore();
  private writeQueue: Promise<void> = Promise.resolve();
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    if (!existsSync(STORE_PATH)) {
      await mkdir(dirname(STORE_PATH), { recursive: true });
      this.loaded = true;
      return;
    }
    try {
      const raw = await readFile(STORE_PATH, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      this.store = {
        active: Array.isArray(parsed.active) ? parsed.active : [],
        history: Array.isArray(parsed.history) ? parsed.history : [],
      };
    } catch (err) {
      console.warn('[claude/sessions] falha ao ler sessions.json, começando vazio:', err);
      this.store = emptyStore();
    }
    this.loaded = true;
  }

  /** Retorna sessões ativas (running/paused). Sessões `crashed` ficam em `active` até o usuário decidir. */
  active(): ClaudeSession[] {
    return [...this.store.active];
  }

  history(): ClaudeSession[] {
    return [...this.store.history];
  }

  get(sessionId: string): ClaudeSession | null {
    return this.store.active.find((s) => s.sessionId === sessionId) ?? null;
  }

  async upsert(session: ClaudeSession): Promise<void> {
    const idx = this.store.active.findIndex((s) => s.sessionId === session.sessionId);
    if (idx >= 0) this.store.active[idx] = session;
    else this.store.active.push(session);
    await this.flush();
  }

  async updateStatus(sessionId: string, status: SessionStatus, pid: number | null = null): Promise<void> {
    const s = this.store.active.find((x) => x.sessionId === sessionId);
    if (!s) return;
    s.status = status;
    if (pid !== null) s.pid = pid;
    s.updatedAt = new Date().toISOString();
    await this.flush();
  }

  async finish(sessionId: string, status: SessionStatus): Promise<void> {
    const idx = this.store.active.findIndex((s) => s.sessionId === sessionId);
    if (idx < 0) return;
    const [done] = this.store.active.splice(idx, 1);
    done.status = status;
    done.updatedAt = new Date().toISOString();
    done.pid = null;
    this.store.history.unshift(done);
    if (this.store.history.length > HISTORY_LIMIT) {
      this.store.history.length = HISTORY_LIMIT;
    }
    await this.flush();
  }

  /** Detecta sessões que ficaram `running` mas o pid não tá mais vivo. Marca crashed. */
  async reconcileOnBoot(): Promise<ClaudeSession[]> {
    const crashed: ClaudeSession[] = [];
    for (const s of this.store.active) {
      if (s.status !== 'running') continue;
      if (s.pid !== null && isPidAlive(s.pid)) continue;
      s.status = 'crashed';
      s.pid = null;
      s.updatedAt = new Date().toISOString();
      crashed.push(s);
    }
    if (crashed.length > 0) await this.flush();
    return crashed;
  }

  private async flush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.writeNow()).catch((err) => {
      console.warn('[claude/sessions] flush falhou:', err);
    });
    return this.writeQueue;
  }

  private async writeNow(): Promise<void> {
    await mkdir(dirname(STORE_PATH), { recursive: true });
    const tmp = `${STORE_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(this.store, null, 2), 'utf8');
    await rename(tmp, STORE_PATH);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let singleton: SessionStore | null = null;
export function getSessionStore(): SessionStore {
  if (!singleton) singleton = new SessionStore();
  return singleton;
}
