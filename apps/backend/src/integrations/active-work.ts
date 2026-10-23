// Tracker de "no que estou trabalhando agora". Persistente em
// ~/pixxel/active-work.json. Cada entrada tem início, fim opcional, descrição
// e (opcional) link com tarefa do ClickUp.
//
// Usado pelo Gemini Live via tools start_work/end_work/current_work, e pelo
// briefing matinal pra sugerir continuar a tarefa que ficou aberta.

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { dataPath } from '../data-dir.js';

const WORK_DIR = dataPath();
const WORK_FILE = join(WORK_DIR, 'active-work.json');
const MAX_HISTORY = 200;

/**
 * Estados de uma sessão:
 * - `running`: ativa agora (não tem endedAt).
 * - `paused`: pausada explicitamente — pode retomar (não tem endedAt).
 * - `completed`: terminou ok (tem endedAt).
 * - `interrupted`: cancelada pelo usuário no meio (tem endedAt) — retomável.
 * - `failed`: falha técnica (tem endedAt) — retomável.
 *
 * Campo opcional: entradas antigas sem `status` são tratadas como `running`
 * se não tem endedAt, senão `completed`.
 */
export type WorkStatus =
  | 'running'
  | 'paused'
  | 'completed'
  | 'interrupted'
  | 'failed';

/**
 * Tipo de sessão. `manual` = usuário disse "vou trabalhar em X" (start_work).
 */
export type WorkKind = 'manual';

export type WorkEntry = {
  /** ISO timestamp do início. */
  startedAt: string;
  /** ISO timestamp do fim. Ausente = sessão em aberto (running ou paused). */
  endedAt?: string;
  /** Estado da sessão. Ausente em entradas antigas — derivar de endedAt. */
  status?: WorkStatus;
  /** Origem. Ausente = manual (compat com entradas antigas). */
  kind?: WorkKind;
  /** O que ele/ela tá fazendo, em uma frase. */
  description: string;
  /** ID/custom ID da task no ClickUp, opcional. */
  clickupTaskId?: string;
  /** Quem está trabalhando — pra distinguir entre Diego e Kamila. */
  owner?: string;
  /** Nota livre (motivo de parar, contexto pra continuar). */
  note?: string;
  /** Project path. Pra retomar precisa do mesmo cwd. */
  cwd?: string;
  /** Nome amigável do projeto, pra exibição. */
  projectName?: string;
  /** Última ação observada — pro usuário lembrar do que tava fazendo ao
   *  retomar. */
  lastStep?: string;
};

function deriveStatus(e: WorkEntry): WorkStatus {
  if (e.status) return e.status;
  return e.endedAt ? 'completed' : 'running';
}

type WorkFile = {
  entries: WorkEntry[];
};

class ActiveWorkStore {
  private entries: WorkEntry[] = [];
  private loaded = false;

  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(WORK_DIR, { recursive: true });
    try {
      const raw = await readFile(WORK_FILE, 'utf8');
      const parsed = JSON.parse(raw) as WorkFile;
      this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('[active-work] load falhou:', err);
      }
      this.entries = [];
    }
    console.log(`[active-work] ${this.entries.length} entrada(s) carregada(s)`);
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    // Mantém só as últimas MAX_HISTORY pra não inchar.
    if (this.entries.length > MAX_HISTORY) {
      this.entries = this.entries.slice(-MAX_HISTORY);
    }
    const tmp = WORK_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify({ entries: this.entries }, null, 2), 'utf8');
    await rename(tmp, WORK_FILE);
  }

  /** Sessão `running` agora. Pausada NÃO conta — usar findPaused() pra isso.
   *  Pode haver no máximo 1 running. */
  current(): WorkEntry | null {
    return (
      this.entries.find((e) => !e.endedAt && deriveStatus(e) === 'running') ?? null
    );
  }

  /** Sessão aberta (sem endedAt) — running OU paused. Prefere running; se não
   *  houver, retorna a paused mais recente. Usado por end/interrupt, que devem
   *  funcionar tanto com sessão ativa quanto pausada. */
  openEntry(): WorkEntry | null {
    const running = this.current();
    if (running) return running;
    const paused = this.pausedEntries();
    return paused[0] ?? null;
  }

  /** Sessões `paused` (sem endedAt, status=paused). Mais recente primeiro. */
  pausedEntries(): WorkEntry[] {
    return this.entries
      .filter((e) => !e.endedAt && deriveStatus(e) === 'paused')
      .reverse();
  }

  /** Sessões retomáveis: paused, interrupted, failed. Mais recente primeiro. */
  resumable(): WorkEntry[] {
    return this.entries
      .filter((e) => {
        const s = deriveStatus(e);
        return s === 'paused' || s === 'interrupted' || s === 'failed';
      })
      .reverse();
  }

  /** Sessões que terminaram (completed/failed/interrupted) nos últimos N min.
   *  Útil pra responder "no que tô trabalhando?" mencionando recém-fechadas
   *  caso o anúncio de Terminei tenha passado batido pelo usuário. */
  recentlyEnded(minutes = 10): WorkEntry[] {
    const cutoff = Date.now() - minutes * 60_000;
    return this.entries
      .filter((e) => {
        if (!e.endedAt) return false;
        const s = deriveStatus(e);
        if (s !== 'completed' && s !== 'failed' && s !== 'interrupted') return false;
        return new Date(e.endedAt).getTime() >= cutoff;
      })
      .reverse();
  }

  /** Última sessão aberta com startedAt nos últimos N dias. */
  lastUnfinished(days = 7): WorkEntry | null {
    const cur = this.current();
    if (!cur) return null;
    const cutoff = Date.now() - days * 86_400_000;
    if (new Date(cur.startedAt).getTime() < cutoff) return null;
    return cur;
  }

  async startWork(input: {
    description: string;
    clickupTaskId?: string;
    owner?: string;
    kind?: WorkKind;
    cwd?: string;
    projectName?: string;
    /** Quando true, fecha sessão aberta antes (compat com fluxo antigo).
     *  Quando false (default), retorna conflict se houver running. */
    forceCloseExisting?: boolean;
  }): Promise<
    | { ok: true; entry: WorkEntry }
    | { ok: false; reason: string }
    | { ok: false; conflict: 'session_open'; current: WorkEntry }
  > {
    const description = input.description.trim();
    if (!description) return { ok: false, reason: 'descrição vazia' };
    const open = this.current();
    if (open) {
      if (!input.forceCloseExisting) {
        return { ok: false, conflict: 'session_open', current: open };
      }
      open.endedAt = new Date().toISOString();
      open.status = 'completed';
      open.note = (open.note ? open.note + ' · ' : '') +
        '[fechada automaticamente ao iniciar nova tarefa]';
    }
    const entry: WorkEntry = {
      startedAt: new Date().toISOString(),
      status: 'running',
      kind: input.kind ?? 'manual',
      description,
      clickupTaskId: input.clickupTaskId?.trim() || undefined,
      owner: input.owner?.trim() || undefined,
      cwd: input.cwd,
      projectName: input.projectName ?? undefined,
    };
    this.entries.push(entry);
    await this.persist();
    return { ok: true, entry };
  }

  async endWork(note?: string): Promise<{ ok: boolean; reason?: string; entry?: WorkEntry }> {
    const open = this.openEntry();
    if (!open) return { ok: false, reason: 'nenhuma sessão de trabalho aberta' };
    open.endedAt = new Date().toISOString();
    open.status = 'completed';
    if (note?.trim()) {
      open.note = (open.note ? open.note + ' · ' : '') + note.trim();
    }
    await this.persist();
    return { ok: true, entry: open };
  }

  /** Pausa a running atual — fica retomável. Não fecha (sem endedAt). */
  async pauseCurrent(note?: string): Promise<{ ok: boolean; reason?: string; entry?: WorkEntry }> {
    const open = this.current();
    if (!open) return { ok: false, reason: 'nenhuma sessão de trabalho aberta' };
    open.status = 'paused';
    if (note?.trim()) {
      open.note = (open.note ? open.note + ' · ' : '') + note.trim();
    }
    await this.persist();
    return { ok: true, entry: open };
  }

  /** Interrompe uma sessão aberta (running ou paused). Fecha com status interrupted. */
  async interruptCurrent(note?: string): Promise<{ ok: boolean; reason?: string; entry?: WorkEntry }> {
    const open = this.openEntry();
    if (!open) return { ok: false, reason: 'nenhuma sessão de trabalho aberta' };
    open.endedAt = new Date().toISOString();
    open.status = 'interrupted';
    if (note?.trim()) {
      open.note = (open.note ? open.note + ' · ' : '') + note.trim();
    }
    await this.persist();
    return { ok: true, entry: open };
  }

  /** Falha técnica — fecha com status failed. Aceita running OU paused. */
  async markFailed(reason?: string): Promise<{ ok: boolean; entry?: WorkEntry }> {
    const open = this.openEntry();
    if (!open) return { ok: false };
    open.endedAt = new Date().toISOString();
    open.status = 'failed';
    if (reason?.trim()) {
      open.note = (open.note ? open.note + ' · ' : '') + `[falha] ${reason.trim()}`;
    }
    await this.persist();
    return { ok: true, entry: open };
  }

  /** Atualiza lastStep da running atual. */
  async updateLastStep(step: string): Promise<void> {
    const open = this.current();
    if (!open) return;
    open.lastStep = step.slice(0, 280);
    await this.persist();
  }

  /** Marca uma entrada retomável como running de novo (resume). */
  async resumeEntry(entryStartedAt: string): Promise<{ ok: boolean; entry?: WorkEntry; reason?: string }> {
    // Antes de retomar, garante que não tem outra running.
    const cur = this.current();
    if (cur) return { ok: false, reason: 'já tem sessão running — pause/interrompa antes' };
    const target = this.entries.find((e) => e.startedAt === entryStartedAt);
    if (!target) return { ok: false, reason: 'entrada não encontrada' };
    target.endedAt = undefined;
    target.status = 'running';
    target.note = (target.note ? target.note + ' · ' : '') +
      `[retomada em ${new Date().toISOString()}]`;
    await this.persist();
    return { ok: true, entry: target };
  }

  /** Lista as últimas N entradas, mais recente primeiro. */
  recent(limit = 10): WorkEntry[] {
    return [...this.entries].reverse().slice(0, limit);
  }
}

let _instance: ActiveWorkStore | null = null;
export function getActiveWorkStore(): ActiveWorkStore {
  if (!_instance) _instance = new ActiveWorkStore();
  return _instance;
}

export function formatRelativeAge(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}min atrás`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h atrás`;
  const d = Math.floor(h / 24);
  return `${d}d atrás`;
}
