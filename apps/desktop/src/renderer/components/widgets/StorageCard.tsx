import type { StorageWidget } from '../../../shared/widgets.js';

function formatGB(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / 1024 ** 2;
  return `${Math.round(mb)} MB`;
}

function severityClass(pct: number): string {
  if (pct >= 90) return 'storage__bar--critical';
  if (pct >= 75) return 'storage__bar--warning';
  return '';
}

export function StorageCard({ data }: { data: StorageWidget }) {
  const totalUsed = data.disks.reduce((s, d) => s + d.usedBytes, 0);
  const totalSize = data.disks.reduce((s, d) => s + d.totalBytes, 0);
  const overall =
    totalSize > 0 ? Math.round((totalUsed / totalSize) * 1000) / 10 : 0;

  return (
    <div className="widget widget--storage">
      <div className="widget__head">
        <span className="widget__kind">armazenamento</span>
        <span className="widget__loc">
          {data.disks.length} {data.disks.length === 1 ? 'disco' : 'discos'}
          {data.scope === 'all' && totalSize > 0 && ` · ${overall}%`}
        </span>
      </div>
      <div className="widget__body">
        <ul className="storage__list">
          {data.disks.map((d) => {
            const sev = severityClass(d.usedPercent);
            return (
              <li key={d.mount} className="storage__item">
                <div className="storage__row">
                  <span className="storage__mount" title={d.mount}>
                    {d.mount}
                  </span>
                  <span className="storage__fstype">{d.fstype}</span>
                  <span className="storage__pct">{d.usedPercent}%</span>
                </div>
                <div className="storage__track">
                  <div
                    className={`storage__bar ${sev}`}
                    style={{ width: `${Math.min(100, d.usedPercent)}%` }}
                  />
                </div>
                <div className="storage__meta">
                  <span>
                    {formatGB(d.usedBytes)} / {formatGB(d.totalBytes)}
                  </span>
                  <span>{formatGB(d.availBytes)} livres</span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
