import { useEffect, useRef, useState } from 'react';
import type { ClaudePermissionRequest, ClaudeState } from '../../shared/ipc.js';
import { useDragHandle } from './widgets/useDragHandle.js';
import { PermissionCard } from './PermissionCard.js';

export type ClaudeMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean }
  | { id: string; kind: 'tool'; tool: string; input?: unknown }
  | { id: string; kind: 'error'; text: string };

/**
 * Resumo de uma linha do input da tool — mostra o que importa por tipo
 * de tool. Pra quando a gente quer feedback rápido no painel sem abrir
 * modal nem JSON cru.
 */
function summarizeToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  switch (tool) {
    case 'Bash':
      return String(obj.command ?? '');
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'NotebookEdit':
      return String(obj.file_path ?? obj.path ?? '');
    case 'Glob':
      return String(obj.pattern ?? '');
    case 'Grep':
      return String(obj.pattern ?? obj.query ?? '');
    case 'LS':
      return String(obj.path ?? '');
    case 'WebFetch':
      return String(obj.url ?? '');
    case 'WebSearch':
      return String(obj.query ?? '');
    default: {
      // Tools desconhecidas: pega o primeiro valor string razoável
      for (const v of Object.values(obj)) {
        if (typeof v === 'string' && v.length > 0 && v.length < 240) return v;
      }
      return '';
    }
  }
}

type Props = {
  state: ClaudeState;
  messages: ClaudeMessage[];
  project: { path: string; name: string | null };
  initialX: number;
  initialY: number;
  pending: ClaudePermissionRequest | null;
  /** Mensagem que o usuário digitou enquanto Claude rodava — vai disparar quando terminar. */
  queued?: string | null;
  onSend: (prompt: string) => void;
  onPermissionDecide: (allowed: boolean) => void;
  onCancel: () => void;
  onClose: () => void;
  onResetSession: () => void;
  onActivate?: () => void;
};

function basename(p: string): string {
  if (!p) return '';
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

export function ClaudePanel({
  state,
  messages,
  project,
  initialX,
  initialY,
  pending,
  queued,
  onSend,
  onPermissionDecide,
  onCancel,
  onClose,
  onResetSession,
  onActivate,
}: Props) {
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pos, dragging, handleProps } = useDragHandle({
    initialX,
    initialY,
    headSelector: '.claude-panel__head',
    ignoreSelector: '.claude-panel__btn',
    onActivate,
  });

  const running = state.kind === 'starting' || state.kind === 'running';

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'auto',
    });
  }, [messages]);

  function send() {
    const text = draft.trim();
    if (!text) return;
    // Durante running: a App enfileira; quando claude terminar, dispara
    // automaticamente. Senão: vira o prompt da próxima run.
    onSend(text);
    setDraft('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const stateLabel = (() => {
    switch (state.kind) {
      case 'idle':
        return 'pronto';
      case 'starting':
        return 'iniciando…';
      case 'running':
        return 'trabalhando…';
      case 'done':
        return 'concluído';
      case 'error':
        return `erro: ${state.reason}`;
    }
  })();

  const projectLabel = project.name ?? basename(project.path);

  return (
    <div
      className={`claude-panel${dragging ? ' claude-panel--dragging' : ''}`}
      style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
      {...handleProps}
    >
      <div className="claude-panel__head">
        <div className="claude-panel__title">
          <span className="claude-panel__brand">claude code</span>
          {projectLabel && (
            <span className="claude-panel__project" title={project.path}>
              📂 {projectLabel}
            </span>
          )}
          <span className={`claude-panel__state claude-panel__state--${state.kind}`}>
            {stateLabel}
          </span>
        </div>
        <div className="claude-panel__head-actions">
          {running && (
            <button
              type="button"
              className="claude-panel__btn claude-panel__btn--cancel"
              onClick={onCancel}
            >
              cancelar
            </button>
          )}
          {!running && messages.length > 0 && (
            <button
              type="button"
              className="claude-panel__btn"
              onClick={onResetSession}
              title="Esquece o contexto e começa uma conversa nova"
            >
              nova conversa
            </button>
          )}
          <button
            type="button"
            className="claude-panel__btn claude-panel__btn--close"
            onClick={onClose}
            aria-label="fechar painel"
          >
            ×
          </button>
        </div>
      </div>

      <div className="claude-panel__messages" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="claude-panel__empty">
            Descreva uma tarefa de codar e o Claude executa neste projeto.
            Cada uso de Bash/Edit/Write pede confirmação.
          </p>
        )}
        {messages.map((m) => {
          if (m.kind === 'user') {
            return (
              <div key={m.id} className="claude-msg claude-msg--user">
                <div className="claude-msg__role">você</div>
                <div className="claude-msg__content">{m.text}</div>
              </div>
            );
          }
          if (m.kind === 'tool') {
            const detail = summarizeToolInput(m.tool, m.input);
            return (
              <div key={m.id} className="claude-msg claude-msg--tool">
                <div className="claude-msg__role">tool</div>
                <div className="claude-msg__content claude-tool">
                  <span className="claude-tool__name">{m.tool}</span>
                  {detail && <span className="claude-tool__arg">{detail}</span>}
                </div>
              </div>
            );
          }
          if (m.kind === 'error') {
            return (
              <div key={m.id} className="claude-msg claude-msg--error">
                <div className="claude-msg__role">erro</div>
                <div className="claude-msg__content">{m.text}</div>
              </div>
            );
          }
          return (
            <div key={m.id} className="claude-msg claude-msg--assistant">
              <div className="claude-msg__role">
                claude{m.streaming ? ' · …' : ''}
              </div>
              <div className="claude-msg__content">
                {m.text || (m.streaming ? '…' : '')}
              </div>
            </div>
          );
        })}

        {pending && (
          <PermissionCard request={pending} onDecide={onPermissionDecide} />
        )}
      </div>

      {queued && (
        <div className="claude-panel__queued">
          <span className="claude-panel__queued-label">na fila</span>
          <span className="claude-panel__queued-text">{queued}</span>
        </div>
      )}

      <div className="claude-panel__compose">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            running
              ? 'Digite — sua mensagem será enviada quando Claude terminar.'
              : 'Tarefa pro Claude. Enter envia, Shift+Enter quebra linha.'
          }
          rows={2}
        />
        <button
          type="button"
          className="claude-panel__btn claude-panel__btn--send"
          onClick={send}
          disabled={!draft.trim()}
        >
          enviar
        </button>
      </div>
    </div>
  );
}
