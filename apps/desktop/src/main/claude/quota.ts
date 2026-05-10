import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

/**
 * Monitora uso do Claude Code (subscription Max) via `ccusage`.
 *
 * Usa `ccusage blocks --token-limit max --json --offline`: o ccusage trata
 * "max" como o maior bloco histórico que o usuário já consumiu — auto-calibra
 * ao plano real (Max 20x, Max 5x, Pro), sem precisar hardcodar limites USD
 * desatualizados. Mesma técnica usada pelo Claude Code statusline.
 *
 * Polling a cada 5min, offline (sem bater na API).
 */

export interface QuotaSnapshot {
  session: {
    totalTokens: number;
    costUSD: number;
    /** Limite de tokens (heurístico: maior bloco já visto pelo ccusage). */
    tokenLimit: number;
    /** Projeção em tokens do bloco atual (já considera burn rate). */
    projectedTokens: number;
    /** Gasto ATUAL: totalTokens / tokenLimit (0-1). "Quanto já gastei agora". */
    actualPct: number;
    /** Projeção: projectedTokens / tokenLimit (0-1). "Quanto vou gastar se continuar nesse ritmo". Base dos alertas. */
    pctOfLimit: number;
    burnRate: {
      tokensPerMinute: number;
      costPerHour: number;
    } | null;
    projection: {
      totalCost: number;
    } | null;
    remainingMinutes: number | null;
    startTime: string | null;
    endTime: string | null;
  };
  weekly: {
    totalCostUSD: number;
    totalTokens: number;
  };
  /** Vem do ccusage: ok / warning / critical (mapeado pra warn/critical). */
  status: 'ok' | 'warn' | 'critical';
  lastUpdated: string;
}

const POLL_INTERVAL_MS = 5 * 60 * 1000;

interface QuotaEvents {
  update: (snapshot: QuotaSnapshot) => void;
  threshold: (status: 'warn' | 'critical', snapshot: QuotaSnapshot) => void;
}

export class QuotaService extends EventEmitter {
  private last: QuotaSnapshot | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastNotifiedStatus: 'ok' | 'warn' | 'critical' = 'ok';

  on<E extends keyof QuotaEvents>(event: E, listener: QuotaEvents[E]): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  emit<E extends keyof QuotaEvents>(event: E, ...args: Parameters<QuotaEvents[E]>): boolean {
    return super.emit(event, ...args);
  }

  async start(): Promise<void> {
    if (this.timer) return;
    await this.refresh().catch((err) => {
      console.warn('[claude/quota] primeira leitura falhou (continua tentando):', err.message);
    });
    this.timer = setInterval(() => {
      void this.refresh().catch((err) => {
        console.warn('[claude/quota] refresh falhou:', err.message);
      });
    }, POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getLast(): QuotaSnapshot | null {
    return this.last;
  }

  isCritical(): boolean {
    return this.last?.status === 'critical';
  }

  async refresh(): Promise<QuotaSnapshot | null> {
    const [blocks, weekly] = await Promise.all([
      runCcusage('blocks', ['--token-limit', 'max']),
      runCcusage('weekly'),
    ]);

    const activeBlock = pickActiveBlock(blocks);
    const sessionCost = activeBlock?.costUSD ?? 0;
    const weeklyCost = (weekly as { totalCost?: number }).totalCost ?? 0;
    const weeklyTokens = (weekly as { totalTokens?: number }).totalTokens ?? 0;

    // ccusage com --token-limit max retorna tokenLimitStatus no bloco ativo.
    const limitStatus = activeBlock?.tokenLimitStatus;
    const sessionPct = limitStatus ? limitStatus.percentUsed / 100 : 0;
    const tokenLimit = limitStatus?.limit ?? 0;
    const projectedTokens = limitStatus?.projectedUsage ?? activeBlock?.projection?.totalTokens ?? 0;
    const totalTokens = activeBlock?.totalTokens ?? 0;
    const actualPct = tokenLimit > 0 ? totalTokens / tokenLimit : 0;

    // Mapeia status do ccusage: 'ok' | 'warning' | 'critical' → nosso enum.
    let status: 'ok' | 'warn' | 'critical' = 'ok';
    if (limitStatus?.status === 'critical') status = 'critical';
    else if (limitStatus?.status === 'warning') status = 'warn';

    const snapshot: QuotaSnapshot = {
      session: {
        totalTokens,
        costUSD: sessionCost,
        tokenLimit,
        projectedTokens,
        actualPct,
        pctOfLimit: sessionPct,
        burnRate: activeBlock?.burnRate ?? null,
        projection: activeBlock?.projection ?? null,
        remainingMinutes: activeBlock?.projection?.remainingMinutes ?? null,
        startTime: activeBlock?.startTime ?? null,
        endTime: activeBlock?.endTime ?? null,
      },
      weekly: {
        totalCostUSD: weeklyCost,
        totalTokens: weeklyTokens,
      },
      status,
      lastUpdated: new Date().toISOString(),
    };

    this.last = snapshot;
    this.emit('update', snapshot);

    // Threshold só dispara em transições UP (ok→warn, warn→critical, ok→critical).
    // Voltas pra baixo (after reset) não geram aviso.
    const ranked = { ok: 0, warn: 1, critical: 2 };
    if (ranked[status] > ranked[this.lastNotifiedStatus]) {
      if (status !== 'ok') {
        this.emit('threshold', status, snapshot);
      }
    }
    this.lastNotifiedStatus = status;

    return snapshot;
  }
}

interface CcusageBlock {
  id: string;
  startTime: string;
  endTime: string;
  isActive: boolean;
  isGap: boolean;
  totalTokens: number;
  costUSD: number;
  burnRate: { tokensPerMinute: number; costPerHour: number } | null;
  projection: { totalTokens: number; totalCost: number; remainingMinutes: number } | null;
  tokenLimitStatus?: {
    limit: number;
    projectedUsage: number;
    percentUsed: number;
    status: 'ok' | 'warning' | 'critical';
  };
}

function pickActiveBlock(blocks: unknown): CcusageBlock | null {
  if (!blocks || typeof blocks !== 'object') return null;
  const arr = (blocks as { blocks?: unknown[] }).blocks;
  if (!Array.isArray(arr)) return null;
  for (const b of arr) {
    if (b && typeof b === 'object' && (b as { isActive?: boolean }).isActive) {
      return b as CcusageBlock;
    }
  }
  return null;
}

function runCcusage(subcommand: string, extraArgs: string[] = []): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const args = ['ccusage', subcommand, ...extraArgs, '--json', '--offline'];
    const child = spawn('npx', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += String(c)));
    child.stderr.on('data', (c) => (err += String(c)));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`ccusage ${subcommand} exit ${code}: ${err.slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(out));
      } catch (e) {
        reject(new Error(`ccusage ${subcommand} json parse: ${(e as Error).message}`));
      }
    });
  });
}

let singleton: QuotaService | null = null;
export function getQuotaService(): QuotaService {
  if (!singleton) singleton = new QuotaService();
  return singleton;
}
