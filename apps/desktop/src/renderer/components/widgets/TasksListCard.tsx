import type { TasksListWidget } from '../../../shared/widgets.js';

const PRIORITY_CLASS: Record<string, string> = {
  urgente: 'task__prio--urgent',
  alta: 'task__prio--high',
  normal: 'task__prio--normal',
  baixa: 'task__prio--low',
};

export function TasksListCard({ data }: { data: TasksListWidget }) {
  return (
    <div className="widget widget--tasks">
      <div className="widget__head">
        <span className="widget__kind">tasks · clickup</span>
        <span className="widget__loc">{data.tasks.length}</span>
      </div>
      <div className="widget__body">
        <div className="tasks__title">{data.title}</div>
        {data.tasks.length === 0 && (
          <div className="tasks__empty">Nenhuma task agora.</div>
        )}
        <ul className="tasks__list">
          {data.tasks.map((t) => {
            const prioClass = t.priority ? PRIORITY_CLASS[t.priority] : '';
            return (
              <li key={t.id} className="task">
                <div className="task__name">{t.name}</div>
                <div className="task__meta">
                  {t.customId && <span className="task__id">{t.customId}</span>}
                  {t.status && <span className="task__status">{t.status}</span>}
                  {t.priority && (
                    <span className={`task__prio ${prioClass}`}>{t.priority}</span>
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
