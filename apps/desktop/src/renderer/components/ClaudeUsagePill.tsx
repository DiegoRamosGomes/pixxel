import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ClaudeUsage } from '../../shared/ipc.js';

type Props = { usage: ClaudeUsage | null };

function formatRemaining(endIso: string): string {
  const ms = new Date(endIso).getTime() - Date.now();
  if (ms <= 0) return 'fim';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return String(n);
}

function formatUSD(v: number): string {
  return '$' + v.toFixed(2);
}

export function ClaudeUsagePill({ usage }: Props) {
  // Countdown re-renderiza quando a Sidebar re-renderiza (props de métricas).
  // Não vale gastar timer dedicado.
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);

  // Reposiciona popover ancorado no rect do botão. Calcula uma vez ao abrir
  // e reage a resize/scroll global pra acompanhar.
  useLayoutEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    const reposition = () => {
      const btn = buttonRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const POPOVER_W = 280;
      const MARGIN = 8;
      // Tenta abrir alinhado à esquerda do botão; se exceder direita do viewport,
      // joga pra esquerda. Mantém pelo menos MARGIN dos bordos.
      let left = r.left;
      if (left + POPOVER_W + MARGIN > window.innerWidth) {
        left = Math.max(MARGIN, window.innerWidth - POPOVER_W - MARGIN);
      }
      const top = r.bottom + MARGIN;
      setPopoverPos({ top, left });
    };
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open]);

  // Fecha popover ao clicar fora (botão + popover, ambos contam como "dentro")
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  if (!usage) {
    return (
      <span className="claude-pill claude-pill--idle" title="Sem dados do Claude — ccusage não retornou">
        claude · —
      </span>
    );
  }

  const hasActiveBlock = !!usage.windowEnd;
  const remaining = hasActiveBlock ? formatRemaining(usage.windowEnd) : null;
  // Headline: % semanal se calibrado; senão cost da janela ativa.
  const weekly = usage.weekly;
  const primary = weekly ? `${weekly.percent}%` : formatUSD(usage.costUSD);
  const primaryClass = weekly
    ? `claude-pill__pct ${weekly.percent >= 90 ? 'claude-pill__pct--danger' : weekly.percent >= 75 ? 'claude-pill__pct--warn' : ''}`
    : 'claude-pill__cost';

  return (
    <div className="claude-pill-wrap" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        className="claude-pill"
        onClick={() => setOpen((v) => !v)}
        title={
          weekly
            ? `${weekly.percent}% do limite semanal · reseta em ${weekly.resetsIn ?? '?'}`
            : 'Detalhes do uso do Claude'
        }
      >
        <span className="claude-pill__label">claude</span>
        <span className={primaryClass}>{primary}</span>
        {remaining && (
          <>
            <span className="claude-pill__sep">·</span>
            <span className="claude-pill__time">↻ {remaining}</span>
          </>
        )}
      </button>
      {open &&
        popoverPos &&
        createPortal(
          <div
            ref={popoverRef}
            className="claude-popover claude-popover--floating"
            role="dialog"
            aria-label="Uso do Claude"
            style={{ top: popoverPos.top, left: popoverPos.left }}
          >
            <ClaudeUsagePopoverInner usage={usage} />
          </div>,
          document.body,
        )}
    </div>
  );
}

function severityClass(pct: number): string {
  if (pct >= 90) return 'danger';
  if (pct >= 75) return 'warn';
  return '';
}

function QuotaRow({
  label,
  reset,
  q,
}: {
  label: string;
  reset?: string;
  q: NonNullable<ClaudeUsage['weekly']>;
}) {
  const sev = severityClass(q.percent);
  return (
    <div className="claude-quota">
      <div className="claude-quota__head">
        <span className="claude-quota__label">{label}</span>
        <span className={`claude-quota__pct claude-quota__pct--${sev || 'ok'}`}>
          {q.percent}%
        </span>
      </div>
      <div className="claude-quota__bar">
        <div
          className={`claude-quota__fill claude-quota__fill--${sev || 'ok'}`}
          style={{ width: `${q.percent}%` }}
        />
      </div>
      <div className="claude-quota__detail">
        <span>
          {formatUSD(q.usedUSD)} de {formatUSD(q.limitUSD)}
        </span>
        {(reset ?? q.resetsIn) && (
          <span className="claude-quota__reset">↻ {reset ?? q.resetsIn}</span>
        )}
      </div>
    </div>
  );
}

function ClaudeUsagePopoverInner({ usage }: { usage: ClaudeUsage }) {
  const proj = usage.projection;
  const hasActiveBlock = !!usage.windowEnd;
  const anyQuota = usage.session || usage.weekly || usage.weeklySonnet;
  return (
    <>
      {anyQuota && (
        <div className="claude-popover__quotas">
          <div className="claude-popover__quotas-title">Usage</div>
          {usage.session && (
            <QuotaRow label="Session (5h)" q={usage.session} />
          )}
          {usage.weekly && (
            <QuotaRow label="Weekly (7 dias)" q={usage.weekly} />
          )}
          {usage.weeklySonnet && (
            <QuotaRow label="Weekly Sonnet" q={usage.weeklySonnet} />
          )}
        </div>
      )}

      {hasActiveBlock && (
        <div className="claude-popover__head">
          <span>Detalhes da janela 5h</span>
          <span className="claude-popover__when">
            {new Date(usage.windowStart).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            {' → '}
            {new Date(usage.windowEnd).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      )}

      <div className="claude-popover__row">
        <span className="claude-popover__k">cost</span>
        <span className="claude-popover__v">{formatUSD(usage.costUSD)}</span>
      </div>
      <div className="claude-popover__row">
        <span className="claude-popover__k">total tokens</span>
        <span className="claude-popover__v">{formatTokens(usage.totalTokens)}</span>
      </div>

      <div className="claude-popover__breakdown">
        <div>
          <div className="claude-popover__bk">in</div>
          <div className="claude-popover__bv">{formatTokens(usage.inputTokens)}</div>
        </div>
        <div>
          <div className="claude-popover__bk">out</div>
          <div className="claude-popover__bv">{formatTokens(usage.outputTokens)}</div>
        </div>
        <div>
          <div className="claude-popover__bk">cache w</div>
          <div className="claude-popover__bv">{formatTokens(usage.cacheCreationTokens)}</div>
        </div>
        <div>
          <div className="claude-popover__bk">cache r</div>
          <div className="claude-popover__bv">{formatTokens(usage.cacheReadTokens)}</div>
        </div>
      </div>

      {usage.burnRate && (
        <div className="claude-popover__row">
          <span className="claude-popover__k">burn rate</span>
          <span className="claude-popover__v">
            {formatUSD(usage.burnRate.costPerHour)}/h ·{' '}
            {formatTokens(Math.round(usage.burnRate.tokensPerMinute))}/min
          </span>
        </div>
      )}

      {proj && (
        <div className="claude-popover__row">
          <span className="claude-popover__k">projeção fim</span>
          <span className="claude-popover__v">
            {formatUSD(proj.totalCost)} · {formatTokens(proj.totalTokens)}
          </span>
        </div>
      )}

      {usage.models.length > 0 && (
        <div className="claude-popover__row claude-popover__models">
          <span className="claude-popover__k">modelos</span>
          <span className="claude-popover__v">
            {usage.models.map((m) => m.replace('claude-', '').replace(/-2025\d+$/, '')).join(', ')}
          </span>
        </div>
      )}
    </>
  );
}
