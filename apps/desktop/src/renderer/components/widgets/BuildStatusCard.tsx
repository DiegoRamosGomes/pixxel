import type { BuildStatusWidget } from '../../../shared/widgets.js';

const STATUS_LABEL: Record<string, string> = {
  started: 'iniciado',
  'in-queue': 'na fila',
  'in-progress': 'rodando',
  finished: 'pronto',
  errored: 'falhou',
  canceled: 'cancelado',
};

const STATUS_ICON: Record<string, string> = {
  started: '▶',
  'in-queue': '⏳',
  'in-progress': '⚙',
  finished: '✓',
  errored: '✕',
  canceled: '⊘',
};

const STATUS_CLASS: Record<string, string> = {
  started: 'build--running',
  'in-queue': 'build--running',
  'in-progress': 'build--running',
  finished: 'build--success',
  errored: 'build--error',
  canceled: 'build--canceled',
};

const PLATFORM_LABEL: Record<string, string> = {
  ios: 'iOS',
  android: 'Android',
};

function timeAgo(ms?: number): string {
  if (!ms) return '';
  const dt = Date.now() - ms;
  if (dt < 60_000) return 'agora';
  const m = Math.floor(dt / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function BuildStatusCard({ data }: { data: BuildStatusWidget }) {
  const sevClass = STATUS_CLASS[data.status] ?? '';
  const label = STATUS_LABEL[data.status] ?? data.status;
  const icon = STATUS_ICON[data.status] ?? '·';
  const platform = data.platform ? PLATFORM_LABEL[data.platform] ?? data.platform : '';
  return (
    <div className={`widget widget--build ${sevClass}`}>
      <div className="widget__head">
        <span className="widget__kind">build · {data.provider}</span>
        <span className="widget__loc">{timeAgo(data.receivedAt)}</span>
      </div>
      <div className="widget__body">
        <div className="build__row">
          <span className="build__icon" aria-hidden>
            {icon}
          </span>
          <div className="build__main">
            <div className="build__name">
              {data.appName ?? 'Build'} {platform && <span className="build__platform">{platform}</span>}
            </div>
            <div className="build__status">{label}</div>
          </div>
        </div>
        <div className="build__actions">
          {data.buildUrl && (
            <a
              href={data.buildUrl}
              target="_blank"
              rel="noreferrer"
              className="build__link"
            >
              Ver no EAS
            </a>
          )}
          {data.artifactUrl && (
            <a
              href={data.artifactUrl}
              target="_blank"
              rel="noreferrer"
              className="build__link build__link--primary"
            >
              Baixar artifact
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
