import { memo, useEffect, useState } from 'react';
import { Sparkline } from './Sparkline.js';

export type SystemMetricsSnapshot = {
  cpuPercent: number;
  memUsedBytes: number;
  memTotalBytes: number;
};

export type ProcessInfo = {
  pid: number;
  name: string;
  cpu: number;
  mem: number;
};

type Props = {
  metrics: SystemMetricsSnapshot | null;
  cpuHistory: number[];
  topProcesses: { topCpu: ProcessInfo[]; topMem: ProcessInfo[] };
  wifi: { ssid: string | null; signal: number | null };
  netBw: { rx: number; tx: number };
  rxHistory: number[];
  txHistory: number[];
};

function fmtBps(bps: number): string {
  if (bps < 1024) return `${bps.toFixed(0)} B/s`;
  if (bps < 1024 * 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${(bps / 1024 / 1024).toFixed(2)} MB/s`;
}

function fmtGiB(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatDate(d: Date): { date: string; weekday: string } {
  // "1 de Maio de 2026" / "TER"
  const months = [
    'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
    'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
  ];
  const weekdays = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
  return {
    date: `${d.getDate()} de ${months[d.getMonth()]} de ${d.getFullYear()}`,
    weekday: weekdays[d.getDay()],
  };
}

// Relógio isolado pra que o tick de 1min não force re-render da Sidebar
// inteira (que tem sparklines, listas de processos etc).
const ClockBlock = memo(function ClockBlock() {
  const [now, setNow] = useState<Date>(new Date());

  useEffect(() => {
    // Alinha o primeiro tick na virada do minuto, depois 60s.
    const msToNextMinute = (60 - new Date().getSeconds()) * 1000;
    let interval: number | null = null;
    const align = window.setTimeout(() => {
      setNow(new Date());
      interval = window.setInterval(() => setNow(new Date()), 60_000);
    }, msToNextMinute);
    return () => {
      window.clearTimeout(align);
      if (interval !== null) window.clearInterval(interval);
    };
  }, []);

  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const { date, weekday } = formatDate(now);

  return (
    <div className="sidebar__clock">
      <div className="sidebar__time">{time}</div>
      <div className="sidebar__date-row">
        <div>
          <div className="sidebar__caption">DATA</div>
          <div className="sidebar__date-val">{date}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="sidebar__caption">DIA</div>
          <div className="sidebar__date-val">{weekday}</div>
        </div>
      </div>
    </div>
  );
});

function SidebarInner({
  metrics,
  cpuHistory,
  topProcesses,
  wifi,
  netBw,
  rxHistory,
  txHistory,
}: Props) {
  return (
    <aside className="sidebar">
      <ClockBlock />

      <div className="sidebar__section">
        <div className="sidebar__section-title">CPU</div>
        <div className="metric">
          <div className="metric__top">
            <span className="metric__pct">
              {metrics ? metrics.cpuPercent.toFixed(1) : '—'}%
            </span>
          </div>
          <Sparkline samples={cpuHistory} max={100} className="spark--cpu" />
        </div>
      </div>

      <div className="sidebar__section">
        <div className="sidebar__section-title">MEMORY</div>
        <div className="metric">
          <div className="metric__top">
            <span className="metric__pct">
              {metrics
                ? Math.round((metrics.memUsedBytes / metrics.memTotalBytes) * 100)
                : '—'}
              %
            </span>
            <span className="metric__sub">
              {metrics
                ? `${fmtGiB(metrics.memUsedBytes)} / ${fmtGiB(metrics.memTotalBytes)} GiB`
                : ''}
            </span>
          </div>
          <div
            className="bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={
              metrics
                ? Math.round((metrics.memUsedBytes / metrics.memTotalBytes) * 100)
                : 0
            }
          >
            <div
              className="bar__fill"
              style={{
                width: metrics
                  ? `${(metrics.memUsedBytes / metrics.memTotalBytes) * 100}%`
                  : '0%',
              }}
            />
          </div>
        </div>
      </div>


      <div className="sidebar__top-grid">
        <div className="sidebar__section">
          <div className="sidebar__section-title">TOP CPU</div>
          <ProcessList items={topProcesses.topCpu} metric="cpu" />
        </div>
        <div className="sidebar__section">
          <div className="sidebar__section-title">TOP MEM</div>
          <ProcessList items={topProcesses.topMem} metric="mem" />
        </div>
      </div>

      <div className="sidebar__section">
        <div className="sidebar__section-title">NETWORK</div>
        <div className="wifi">
          <div className="wifi__main">
            <span className="wifi__ssid" title={wifi.ssid ?? 'desconectado'}>
              {wifi.ssid ?? '—'}
            </span>
            <SignalBars signal={wifi.signal} />
          </div>
          {wifi.signal != null && (
            <div className="wifi__sub">{wifi.signal}%</div>
          )}
        </div>

        <BandwidthRow
          arrow="↓"
          label="DOWN"
          rate={netBw.rx}
          history={rxHistory}
        />
        <BandwidthRow
          arrow="↑"
          label="UP"
          rate={netBw.tx}
          history={txHistory}
        />
      </div>
    </aside>
  );
}

export const Sidebar = memo(SidebarInner);

function BandwidthRow({
  arrow,
  label,
  rate,
  history,
}: {
  arrow: string;
  label: string;
  rate: number;
  history: number[];
}) {
  // Escala dinâmica: max do histórico, com piso de 50KB/s pra idle não
  // ficar com a linha colada no topo de qualquer ruído.
  const peak = history.length > 0 ? Math.max(...history) : 0;
  const max = Math.max(50 * 1024, peak * 1.1);
  return (
    <div className="bw-row">
      <div className="bw-row__head">
        <span className="bw-row__label">
          <span className="bw-row__arrow">{arrow}</span> {label}
        </span>
        <span className="bw-row__rate">{fmtBps(rate)}</span>
      </div>
      <Sparkline samples={history} max={max} className="spark--bw" />
    </div>
  );
}

function SignalBars({ signal }: { signal: number | null }) {
  // 4 barras crescentes; nº ativas baseado em signal/25.
  const active = signal == null ? 0 : Math.max(0, Math.min(4, Math.ceil(signal / 25)));
  return (
    <div className="signal-bars" aria-label={`Sinal ${signal ?? 0}%`}>
      {[1, 2, 3, 4].map((i) => (
        <span
          key={i}
          className={`signal-bars__bar ${i <= active ? 'signal-bars__bar--on' : ''}`}
          style={{ height: `${i * 25}%` }}
        />
      ))}
    </div>
  );
}

function ProcessList({
  items,
  metric,
}: {
  items: ProcessInfo[];
  metric: 'cpu' | 'mem';
}) {
  if (items.length === 0) {
    return <div className="sidebar__muted">—</div>;
  }
  return (
    <ul className="proc-list">
      {items.map((p) => {
        const value = metric === 'cpu' ? p.cpu : p.mem;
        return (
          <li key={p.pid} className="proc">
            <div className="proc__main">
              <span className="proc__name" title={`${p.name} (pid ${p.pid})`}>
                {p.name}
              </span>
              <span className="proc__val">{value.toFixed(1)}%</span>
            </div>
            <div className="proc__pid">{p.pid}</div>
          </li>
        );
      })}
    </ul>
  );
}
