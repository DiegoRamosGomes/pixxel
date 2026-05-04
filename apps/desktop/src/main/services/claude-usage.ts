// Polls `ccusage blocks --json --offline` periodicamente e emite o snapshot
// do bloco ativo de 5h pra UI. Nenhum dado do Claude vai pra rede — `ccusage`
// lê os arquivos locais em `~/.claude/projects/**/*.jsonl`.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import type { ClaudeUsage } from '../../shared/ipc.js';

// Sessão de 5h muda devagar — 5min de polling é mais que suficiente.
const POLL_INTERVAL_MS = 5 * 60_000;
const MAX_BUFFER = 4 * 1024 * 1024; // 4MB safety cap pro stdout

type CcusageBlock = {
  id: string;
  startTime: string;
  endTime: string;
  actualEndTime: string | null;
  isActive: boolean;
  isGap: boolean;
  entries: number;
  tokenCounts: {
    inputTokens: number;
    outputTokens: number;
    cacheCreationInputTokens: number;
    cacheReadInputTokens: number;
  };
  totalTokens: number;
  costUSD: number;
  models: string[];
  burnRate: {
    tokensPerMinute: number;
    tokensPerMinuteForIndicator: number;
    costPerHour: number;
  } | null;
  projection: {
    totalTokens: number;
    totalCost: number;
    remainingMinutes: number;
  } | null;
};

let cachedBin: string | null = null;

function ccusageBin(): string {
  if (cachedBin) return cachedBin;
  // Procura o binário em vários locais possíveis (workspace root, app local).
  // Dev: node_modules é hoisted pra raiz; packed: dentro do asar.
  const appPath = app.getAppPath();
  const candidates = [
    join(appPath, 'node_modules', '.bin', 'ccusage'),
    join(appPath, '..', '..', 'node_modules', '.bin', 'ccusage'),
    join(process.cwd(), 'node_modules', '.bin', 'ccusage'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedBin = c;
      return c;
    }
  }
  // Fallback — confia no PATH (caso o usuário tenha instalado global)
  cachedBin = 'ccusage';
  return cachedBin;
}

type CcusageWeek = {
  week: string;
  totalCost: number;
  totalTokens: number;
  modelBreakdowns?: Array<{ modelName: string; cost: number }>;
};

function spawnCcusage(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(ccusageBin(), args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      reject(new Error(`ccusage timeout (>${timeoutMs}ms): ${args.join(' ')}`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > MAX_BUFFER) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
        reject(new Error('ccusage stdout too large'));
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        reject(new Error(`ccusage exit ${code}: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseLimit(envName: string): number | undefined {
  const raw = process.env[envName] ?? '';
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function buildQuota(
  used: number,
  limit: number,
  resetsAt?: string,
): { usedUSD: number; limitUSD: number; percent: number; resetsAt?: string; resetsIn?: string } {
  const percent = Math.min(100, Math.round((used / limit) * 100));
  const out: {
    usedUSD: number;
    limitUSD: number;
    percent: number;
    resetsAt?: string;
    resetsIn?: string;
  } = { usedUSD: used, limitUSD: limit, percent };
  if (resetsAt) {
    out.resetsAt = resetsAt;
    out.resetsIn = formatDistance(resetsAt);
  }
  return out;
}

function formatDistance(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'fim';
  const totalMin = Math.round(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  if (days >= 1) return `${days}d`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

/** Estima reset da semana: domingo 23:59 da semana corrente (formato ccusage
 *  `week` é "YYYY-MM-DD" da segunda-feira). +6 dias 23h59m. */
function weekResetIso(weekStart: string): string {
  const d = new Date(weekStart + 'T00:00:00');
  d.setDate(d.getDate() + 7);
  return d.toISOString();
}

async function fetchBlocks(): Promise<CcusageBlock[]> {
  const stdout = await spawnCcusage(['blocks', '--json', '--offline']);
  const data = JSON.parse(stdout) as { blocks?: CcusageBlock[] };
  return data.blocks ?? [];
}

/** Calcula a segunda-feira da semana corrente em formato YYYYMMDD (ccusage `--since`). */
function currentWeekSinceArg(): string {
  const d = new Date();
  // segunda = 1, domingo = 0 → calcula offset pra segunda
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : 1 - dow; // segunda da semana corrente
  d.setDate(d.getDate() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

async function fetchCurrentWeek(): Promise<CcusageWeek | null> {
  // Restringe a janela ao mínimo (semana corrente) — sem isso, ccusage
  // processa o histórico inteiro e dá timeout em vaults grandes.
  const since = currentWeekSinceArg();
  const stdout = await spawnCcusage(
    ['weekly', '--json', '--offline', '--since', since],
    30_000,
  );
  const data = JSON.parse(stdout) as { weekly?: CcusageWeek[] };
  const weeks = data.weekly ?? [];
  if (weeks.length === 0) return null;
  return weeks[weeks.length - 1];
}

function activeBlockToUsage(block: CcusageBlock): ClaudeUsage {
  return {
    windowStart: block.startTime,
    windowEnd: block.endTime,
    costUSD: block.costUSD,
    totalTokens: block.totalTokens,
    inputTokens: block.tokenCounts.inputTokens,
    outputTokens: block.tokenCounts.outputTokens,
    cacheCreationTokens: block.tokenCounts.cacheCreationInputTokens,
    cacheReadTokens: block.tokenCounts.cacheReadInputTokens,
    models: block.models,
    burnRate: block.burnRate
      ? {
          tokensPerMinute: block.burnRate.tokensPerMinute,
          costPerHour: block.burnRate.costPerHour,
        }
      : undefined,
    projection: block.projection
      ? {
          totalTokens: block.projection.totalTokens,
          totalCost: block.projection.totalCost,
          remainingMinutes: block.projection.remainingMinutes,
        }
      : undefined,
  };
}

const WEEK_CACHE_MS = 10 * 60_000; // weekly muda devagar — 10min de cache.

export class ClaudeUsageService {
  private timer: NodeJS.Timeout | null = null;
  private last: ClaudeUsage | null = null;
  private weekCache: { at: number; data: CcusageWeek | null } | null = null;
  private weekFetchInFlight: Promise<CcusageWeek | null> | null = null;

  constructor(private readonly onUpdate: (usage: ClaudeUsage | null) => void) {}

  async start(): Promise<void> {
    if (this.timer) return;
    void this.tick(); // primeira amostra imediata
    this.timer = setInterval(() => void this.tick(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Para forçar uma atualização (ex.: usuário acabou de abrir uma sessão Claude) */
  refresh(): void {
    void this.tick();
  }

  private async getCachedWeek(): Promise<CcusageWeek | null> {
    const now = Date.now();
    if (this.weekCache && now - this.weekCache.at < WEEK_CACHE_MS) {
      return this.weekCache.data;
    }
    // Evita disparar várias chamadas simultâneas se o tick disparar de novo
    // antes de a anterior terminar (weekly demora ~12s).
    if (this.weekFetchInFlight) return this.weekFetchInFlight;
    this.weekFetchInFlight = fetchCurrentWeek()
      .then((data) => {
        this.weekCache = { at: Date.now(), data };
        return data;
      })
      .catch((err) => {
        console.warn(
          '[claude-usage] weekly falhou:',
          err instanceof Error ? err.message : err,
        );
        // Mantém o cache antigo se houver — degrada silenciosamente
        return this.weekCache?.data ?? null;
      })
      .finally(() => {
        this.weekFetchInFlight = null;
      });
    return this.weekFetchInFlight;
  }

  private async tick(): Promise<void> {
    try {
      const [blocks, week] = await Promise.all([
        fetchBlocks().catch((err) => {
          console.warn(
            '[claude-usage] blocks falhou:',
            err instanceof Error ? err.message : err,
          );
          return [] as CcusageBlock[];
        }),
        this.getCachedWeek(),
      ]);

      const active = blocks.find((b) => b.isActive && !b.isGap);
      let usage = active ? activeBlockToUsage(active) : null;

      if (!usage) {
        usage = {
          windowStart: '',
          windowEnd: '',
          costUSD: 0,
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
          models: [],
        };
      }

      // === Quotas calibradas via env vars ===
      const sessionLimit = parseLimit('CLAUDE_SESSION_LIMIT_USD');
      const weeklyLimit = parseLimit('CLAUDE_WEEKLY_LIMIT_USD');
      const sonnetLimit = parseLimit('CLAUDE_WEEKLY_SONNET_LIMIT_USD');

      // Session 5h
      if (sessionLimit && active) {
        usage.session = buildQuota(active.costUSD, sessionLimit, active.endTime);
      }

      // Weekly total
      if (weeklyLimit && week) {
        usage.weekly = buildQuota(
          week.totalCost,
          weeklyLimit,
          weekResetIso(week.week),
        );
      }

      // Weekly Sonnet — soma cost dos modelos com 'sonnet' no nome
      if (sonnetLimit && week) {
        const sonnetCost =
          week.modelBreakdowns
            ?.filter((m) => /sonnet/i.test(m.modelName))
            .reduce((a, b) => a + b.cost, 0) ?? 0;
        usage.weeklySonnet = buildQuota(
          sonnetCost,
          sonnetLimit,
          weekResetIso(week.week),
        );
      }

      this.last = usage;
      this.onUpdate(usage);
    } catch (err) {
      console.warn(
        '[claude-usage] ccusage falhou:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  getLast(): ClaudeUsage | null {
    return this.last;
  }
}

// Registro singleton pra módulos que rodam fora do fluxo de tool calls do
// Live (ex.: briefing.ts) lerem o último snapshot sem precisar passar a
// instância como parâmetro.
let activeService: ClaudeUsageService | null = null;

export function setActiveClaudeUsageService(s: ClaudeUsageService | null): void {
  activeService = s;
}

export function getCurrentClaudeUsage(): ClaudeUsage | null {
  return activeService?.getLast() ?? null;
}
