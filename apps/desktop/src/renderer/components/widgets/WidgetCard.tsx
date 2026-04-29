import { useEffect, useRef, useState } from 'react';
import type { Widget } from '../../../shared/widgets.js';
import { WeatherCard } from './WeatherCard.js';
import { TasksListCard } from './TasksListCard.js';
import { TaskDetailCard } from './TaskDetailCard.js';
import { YoutubeCard } from './YoutubeCard.js';

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
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const [dragging, setDragging] = useState(false);
  const dragStateRef = useRef<{
    startCursorX: number;
    startCursorY: number;
    startWidgetX: number;
    startWidgetY: number;
  } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const s = dragStateRef.current;
      if (!s) return;
      setPos({
        x: s.startWidgetX + (e.clientX - s.startCursorX),
        y: s.startWidgetY + (e.clientY - s.startCursorY),
      });
    };
    const onUp = () => {
      setDragging(false);
      dragStateRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  function handleMouseDown(e: React.MouseEvent) {
    const target = e.target as HTMLElement;
    // Drag só inicia se o mousedown for no header. Ignora clique no botão close.
    if (target.closest('.widget-close')) return;
    if (!target.closest('.widget__head')) return;
    e.preventDefault();
    onActivate?.();
    dragStateRef.current = {
      startCursorX: e.clientX,
      startCursorY: e.clientY,
      startWidgetX: pos.x,
      startWidgetY: pos.y,
    };
    setDragging(true);
  }

  return (
    <div
      className={`widget-wrap${dragging ? ' widget-wrap--dragging' : ''}`}
      style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
      onMouseDown={handleMouseDown}
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
  }
}
