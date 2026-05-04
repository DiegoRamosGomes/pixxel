import type { SearchResultsWidget } from '../../../shared/widgets.js';

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

export function SearchResultsCard({ data }: { data: SearchResultsWidget }) {
  return (
    <div className="widget widget--search">
      <div className="widget__head">
        <span className="widget__kind">pesquisa</span>
        <span className="widget__sub">{data.query}</span>
      </div>
      <div className="widget__body">
        <ul className="search-list">
          {data.results.map((r, i) => (
            <li key={r.url} className="search-item">
              <a
                href={r.url}
                target="_blank"
                rel="noreferrer"
                className="search-item__link"
                title={r.url}
              >
                <span className="search-item__rank">{i + 1}</span>
                <div className="search-item__body">
                  <div className="search-item__title">{r.title}</div>
                  <div className="search-item__host">{hostname(r.url)}</div>
                  {r.snippet && (
                    <div className="search-item__snippet">{r.snippet}</div>
                  )}
                </div>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
