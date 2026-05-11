import type { TrelloCardsListWidget } from '../../../shared/widgets.js';

function formatDue(due?: string): string | null {
  if (!due) return null;
  try {
    return new Date(due).toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
    });
  } catch {
    return null;
  }
}

export function TrelloCardsListCard({ data }: { data: TrelloCardsListWidget }) {
  return (
    <div className="widget widget--trello-cards">
      <div className="widget__head">
        <span className="widget__kind">
          trello{data.boardName ? ` · ${data.boardName}` : ''}
        </span>
        <span className="widget__loc">{data.cards.length}</span>
      </div>
      <div className="widget__body">
        <div className="tasks__title">{data.title}</div>
        {data.cards.length === 0 && (
          <div className="tasks__empty">Sem cards.</div>
        )}
        <ul className="tasks__list">
          {data.cards.map((c) => {
            const due = formatDue(c.due);
            return (
              <li key={c.id} className="task">
                <div className="task__name">{c.name}</div>
                <div className="task__meta">
                  {due && (
                    <span
                      className={`task__status${c.dueComplete ? ' task__status--done' : ''}`}
                    >
                      {c.dueComplete ? '✓ ' : ''}
                      {due}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
