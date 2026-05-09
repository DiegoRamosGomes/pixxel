import type { NotificationsWidget } from '../../../shared/widgets.js';

const KIND_ICON: Record<NotificationsWidget['items'][number]['kind'], string> = {
  task_assigned: '📥',
  task_comment: '💬',
  mention: '@',
  chat_message: '✉',
  other: '•',
};

const KIND_LABEL: Record<NotificationsWidget['items'][number]['kind'], string> = {
  task_assigned: 'task atribuída',
  task_comment: 'comentário',
  mention: 'menção',
  chat_message: 'mensagem',
  other: 'notificação',
};

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'agora';
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

export function NotificationsCard({ data }: { data: NotificationsWidget }) {
  return (
    <div className="widget widget--notifications">
      <div className="widget__head">
        <span className="widget__kind">notificações</span>
        <span className="widget__loc">
          {data.items.length} {data.items.length === 1 ? 'nova' : 'novas'} · {data.source}
        </span>
      </div>
      <div className="widget__body">
        <ul className="notif__list">
          {data.items.map((item) => {
            // Items com taskId viram botões clicáveis: pede pro Gemini explicar
            // a task (vai disparar tool clickup_explain_task que abre widget +
            // fala). Items sem taskId (ex: chat_message) ficam estáticos.
            const clickable = !!item.taskId;
            const Body = (
              <>
                <div className="notif__row">
                  <span className="notif__icon" aria-hidden>
                    {KIND_ICON[item.kind]}
                  </span>
                  <span className="notif__title" title={item.title}>
                    {item.title}
                  </span>
                  <span className="notif__age">{timeAgo(item.date)}</span>
                </div>
                <div className="notif__sub">
                  <span className="notif__kind-tag">{KIND_LABEL[item.kind]}</span>
                  {item.actor && <span className="notif__actor">por {item.actor}</span>}
                  {item.taskId && <span className="notif__task-id">#{item.taskId}</span>}
                </div>
                {item.detail && <div className="notif__detail">{item.detail}</div>}
              </>
            );
            return (
              <li key={item.id} className="notif__item">
                {clickable ? (
                  <button
                    type="button"
                    className="notif__btn"
                    onClick={() => window.assistant.explainClickupTask(item.taskId!)}
                    title="Pedir pro Pixxel explicar essa task"
                  >
                    {Body}
                  </button>
                ) : (
                  Body
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
