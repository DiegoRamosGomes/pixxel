import type { Widget } from '../../../shared/widgets.js';
import { WeatherCard } from './WeatherCard.js';
import { TasksListCard } from './TasksListCard.js';
import { TaskDetailCard } from './TaskDetailCard.js';
import { YoutubeCard } from './YoutubeCard.js';
import { SearchResultsCard } from './SearchResultsCard.js';
import { StorageCard } from './StorageCard.js';
import { NotificationsCard } from './NotificationsCard.js';
import { BuildStatusCard } from './BuildStatusCard.js';
import { useDragHandle } from './useDragHandle.js';

type Props = {
  widget: Widget;
  initialX: number;
  initialY: number;
  onDismiss: () => void;
  onActivate?: () => void;
};

export function WidgetCard({
  widget,
  initialX,
  initialY,
  onDismiss,
  onActivate,
}: Props) {
  const { pos, dragging, handleProps } = useDragHandle({
    initialX,
    initialY,
    headSelector: '.widget__head',
    ignoreSelector: '.widget-close',
    onActivate,
  });

  return (
    <div
      className={`widget-wrap${dragging ? ' widget-wrap--dragging' : ''}`}
      style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
      {...handleProps}
    >
      <button
        type="button"
        className="widget-close"
        aria-label="fechar"
        onClick={onDismiss}
      >
        ×
      </button>
      {renderInner(widget)}
    </div>
  );
}

function renderInner(widget: Widget) {
  switch (widget.kind) {
    case 'weather':
      return <WeatherCard data={widget} />;
    case 'tasks-list':
      return <TasksListCard data={widget} />;
    case 'task-detail':
      return <TaskDetailCard data={widget} />;
    case 'youtube':
      return <YoutubeCard data={widget} />;
    case 'search-results':
      return <SearchResultsCard data={widget} />;
    case 'storage':
      return <StorageCard data={widget} />;
    case 'notifications':
      return <NotificationsCard data={widget} />;
    case 'build-status':
      return <BuildStatusCard data={widget} />;
  }
}
