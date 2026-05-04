import { useEffect, useRef, useState } from 'react';

type Options = {
  initialX: number;
  initialY: number;
  /** CSS selector que identifica o "header" arrastável dentro do componente */
  headSelector: string;
  /** CSS selector pra elementos que NÃO devem disparar drag mesmo se dentro do head (botões etc) */
  ignoreSelector?: string;
  /** Callback ao iniciar drag — pra trazer pra frente (z-index) */
  onActivate?: () => void;
};

type Result = {
  pos: { x: number; y: number };
  dragging: boolean;
  /** Spreadar no elemento raiz: <div {...handleProps} ...> */
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void;
  };
};

export function useDragHandle({
  initialX,
  initialY,
  headSelector,
  ignoreSelector,
  onActivate,
}: Options): Result {
  const [pos, setPos] = useState({ x: initialX, y: initialY });
  const [dragging, setDragging] = useState(false);
  const stateRef = useRef<{
    startCursorX: number;
    startCursorY: number;
    startWidgetX: number;
    startWidgetY: number;
  } | null>(null);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const s = stateRef.current;
      if (!s) return;
      setPos({
        x: s.startWidgetX + (e.clientX - s.startCursorX),
        y: s.startWidgetY + (e.clientY - s.startCursorY),
      });
    };
    const onUp = () => {
      setDragging(false);
      stateRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging]);

  function onMouseDown(e: React.MouseEvent) {
    // Sobe o z-index em QUALQUER clique no painel, não só no header — senão
    // clicar no corpo (ex: selecionar texto do chat) deixa o painel atrás
    // de outros que estão na frente.
    onActivate?.();
    const target = e.target as HTMLElement;
    if (ignoreSelector && target.closest(ignoreSelector)) return;
    if (!target.closest(headSelector)) return;
    e.preventDefault();
    stateRef.current = {
      startCursorX: e.clientX,
      startCursorY: e.clientY,
      startWidgetX: pos.x,
      startWidgetY: pos.y,
    };
    setDragging(true);
  }

  return {
    pos,
    dragging,
    handleProps: { onMouseDown },
  };
}
