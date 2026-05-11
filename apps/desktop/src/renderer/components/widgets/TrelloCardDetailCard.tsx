import type { TrelloCardDetailWidget } from '../../../shared/widgets.js';

function formatDue(due?: string): string | null {
  if (!due) return null;
  try {
    return new Date(due).toLocaleDateString('pt-BR');
  } catch {
    return null;
  }
}

export function TrelloCardDetailCard({ data }: { data: TrelloCardDetailWidget }) {
  const { card, labels, checklists, comments } = data;
  const due = formatDue(card.due);
  return (
    <div className="widget widget--trello-detail">
      <div className="widget__head">
        <span className="widget__kind">
          trello · {card.boardName}
          {card.listName ? ` › ${card.listName}` : ''}
        </span>
        {card.closed && <span className="widget__loc">arquivado</span>}
      </div>
      <div className="widget__body">
        <div className="task-detail__title">{card.name}</div>
        <div className="task-detail__meta">
          {due && (
            <span className="task__prio">
              {card.dueComplete ? '✓ ' : ''}vencimento: {due}
            </span>
          )}
        </div>
        {labels.length > 0 && (
          <div className="trello__labels">
            {labels.map((l, i) => (
              <span
                key={i}
                className="trello__label"
                style={l.color ? { borderColor: 'currentColor' } : undefined}
                data-color={l.color ?? 'none'}
              >
                {l.name || '(sem nome)'}
              </span>
            ))}
          </div>
        )}
        {card.desc && (
          <div className="task-detail__desc">
            {card.desc.slice(0, 600)}
            {card.desc.length > 600 ? '…' : ''}
          </div>
        )}
        {checklists.length > 0 && (
          <div className="trello__checklists">
            {checklists.map((cl, i) => {
              const done = cl.items.filter((it) => it.complete).length;
              return (
                <div key={i} className="trello__checklist">
                  <div className="trello__checklist-head">
                    {cl.name}{' '}
                    <span className="trello__checklist-count">
                      {done}/{cl.items.length}
                    </span>
                  </div>
                  <ul className="trello__checklist-items">
                    {cl.items.slice(0, 8).map((it, j) => (
                      <li
                        key={j}
                        className={`trello__checklist-item${it.complete ? ' trello__checklist-item--done' : ''}`}
                      >
                        {it.complete ? '✓ ' : '○ '}
                        {it.name}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
        {comments.length > 0 && (
          <div className="task-detail__comments">
            <div className="task-detail__comments-title">
              {comments.length} comentário{comments.length === 1 ? '' : 's'}
            </div>
            <ul>
              {comments.slice(0, 5).map((c, i) => (
                <li key={i}>
                  <strong>{c.author}:</strong>{' '}
                  {c.text.length > 200 ? c.text.slice(0, 200) + '…' : c.text}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
