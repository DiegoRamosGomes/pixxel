import type { TaskDetailWidget } from '../../../shared/widgets.js';

export function TaskDetailCard({ data }: { data: TaskDetailWidget }) {
  const { task, comments } = data;
  return (
    <div className="widget widget--task-detail">
      <div className="widget__head">
        <span className="widget__kind">task · {task.customId ?? task.id}</span>
        {task.status && <span className="widget__loc">{task.status}</span>}
      </div>
      <div className="widget__body">
        <div className="task-detail__title">{task.name}</div>
        <div className="task-detail__meta">
          {task.priority && (
            <span className="task__prio">prioridade: {task.priority}</span>
          )}
          {task.list && <span>lista: {task.list}</span>}
          {task.space && <span>espaço: {task.space}</span>}
        </div>
        {task.description && (
          <div className="task-detail__desc">
            {task.description.slice(0, 600)}
            {task.description.length > 600 ? '…' : ''}
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
