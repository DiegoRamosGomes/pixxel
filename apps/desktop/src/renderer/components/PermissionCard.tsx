// Card inline (renderizado dentro do ClaudePanel) substituindo o modal
// fullscreen. Mostra o request, o detalhe rico (diff/cmd) e os botões.
// Atalhos Enter/Esc continuam ativos via listener global enquanto montado.

import { useEffect, useState } from 'react';
import type { ClaudePermissionRequest } from '../../shared/ipc.js';
import { ToolDetails } from './ToolDetails.js';

const TIMEOUT_SECONDS = 60;

type Props = {
  request: ClaudePermissionRequest;
  onDecide: (allowed: boolean) => void;
};

export function PermissionCard({ request, onDecide }: Props) {
  const [secondsLeft, setSecondsLeft] = useState(TIMEOUT_SECONDS);

  useEffect(() => {
    setSecondsLeft(TIMEOUT_SECONDS);
    const id = window.setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [request.requestId]);

  // Atalhos: Enter aprova, Esc nega — só dispara se foco NÃO está num campo
  // editável (textarea, input). Senão estraga o digitar livre no textarea.
  useEffect(() => {
    function isEditable(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
      return el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      if (isEditable(e.target)) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        onDecide(true);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onDecide(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDecide]);

  const richDetail = ['Edit', 'Write', 'Bash'].includes(request.tool);

  return (
    <div className="perm-card" role="region" aria-label="Pedido de permissão do Claude">
      <div className="perm-card__head">
        <span className="perm-card__tag">claude pede permissão</span>
        <span className="perm-card__timer">{secondsLeft}s</span>
      </div>
      <div className="perm-card__body">
        <div className="perm-card__tool">
          <span className="perm-card__tool-name">{request.tool}</span>
        </div>
        <p className="perm-card__summary">{request.summary}</p>
        {richDetail ? (
          <ToolDetails tool={request.tool} input={request.input} />
        ) : (
          <details className="perm-card__details">
            <summary>ver detalhes</summary>
            <pre>{JSON.stringify(request.input, null, 2)}</pre>
          </details>
        )}
      </div>
      <div className="perm-card__actions">
        <button
          type="button"
          className="perm-card__btn perm-card__btn--deny"
          onClick={() => onDecide(false)}
          title="Esc"
        >
          Não
        </button>
        <button
          type="button"
          className="perm-card__btn perm-card__btn--allow"
          onClick={() => onDecide(true)}
          title="Enter"
        >
          Sim
        </button>
      </div>
    </div>
  );
}
