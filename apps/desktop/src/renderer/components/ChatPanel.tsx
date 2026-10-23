import { useEffect, useRef, useState } from 'react';
import type { ConnState, LiveState } from '../../shared/ipc.js';
import { useDragHandle } from './widgets/useDragHandle.js';

type Role = 'user' | 'assistant';

export type ChatMessage =
  | {
      id: string;
      kind: 'text';
      role: Role;
      content: string;
      streaming: boolean;
      model?: string;
    };

type Props = {
  messages: ChatMessage[];
  conn: ConnState;
  live: LiveState;
  initialX: number;
  initialY: number;
  onSend: (text: string) => void;
  onClose: () => void;
  onActivate?: () => void;
};

type IgPublish = {
  file: File;
  previewUrl: string;
  caption: string;
  shareToFeed: boolean;
  status: 'idle' | 'publishing' | 'done' | 'error';
  message?: string;
};

export function ChatPanel({
  messages,
  conn,
  live,
  initialX,
  initialY,
  onSend,
  onClose,
  onActivate,
}: Props) {
  const [draft, setDraft] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [igModal, setIgModal] = useState<IgPublish | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { pos, dragging, handleProps } = useDragHandle({
    initialX,
    initialY,
    headSelector: '.chat-panel__head',
    ignoreSelector: '.chat-panel__btn',
    onActivate,
  });

  const liveReady = live.kind === 'ready' || live.kind === 'speaking';
  const canSend = liveReady || conn === 'open';

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'auto',
    });
  }, [messages]);

  function send() {
    const text = draft.trim();
    if (!text || !canSend) return;
    onSend(text);
    setDraft('');
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  function onDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      setDragOver(true);
    }
  }

  function onDragLeave(e: React.DragEvent) {
    if (e.currentTarget === e.target) setDragOver(false);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) return;
    setIgModal({
      file,
      previewUrl: URL.createObjectURL(file),
      caption: '',
      shareToFeed: false,
      status: 'idle',
    });
  }

  async function publishIg() {
    if (!igModal || igModal.status === 'publishing') return;
    setIgModal({ ...igModal, status: 'publishing', message: undefined });
    try {
      const buf = await igModal.file.arrayBuffer();
      const r = await window.assistant.instagramPublish(
        buf,
        igModal.file.name,
        igModal.caption,
        igModal.shareToFeed,
      );
      if (r.ok) {
        setIgModal({
          ...igModal,
          status: 'done',
          message: r.permalink ?? 'publicado',
        });
      } else {
        setIgModal({
          ...igModal,
          status: 'error',
          message: r.reason ?? 'falhou',
        });
      }
    } catch (err) {
      setIgModal({
        ...igModal,
        status: 'error',
        message: err instanceof Error ? err.message : 'falhou',
      });
    }
  }

  function closeIgModal() {
    if (igModal) URL.revokeObjectURL(igModal.previewUrl);
    setIgModal(null);
  }

  const placeholder = liveReady
    ? 'Digite — Pixxel responde por voz…'
    : conn === 'open'
      ? 'Digite uma mensagem…'
      : 'Aguardando conexão com o backend…';

  return (
    <div
      className={`chat-panel${dragging ? ' chat-panel--dragging' : ''}${dragOver ? ' chat-panel--drop' : ''}`}
      style={{ transform: `translate3d(${pos.x}px, ${pos.y}px, 0)` }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      {...handleProps}
    >
      <div className="chat-panel__head">
        <div className="chat-panel__title">
          <span className="chat-panel__brand">chat</span>
          <span className="chat-panel__sub">
            {liveReady ? 'live' : conn === 'open' ? 'texto' : 'offline'}
          </span>
        </div>
        <button
          type="button"
          className="chat-panel__btn chat-panel__btn--close"
          onClick={onClose}
          aria-label="fechar chat"
        >
          ×
        </button>
      </div>

      <div className="chat-panel__messages" ref={scrollRef}>
        {messages.length === 0 && (
          <p className="chat-panel__empty">
            Diga oi pra começar. Enter envia, Shift+Enter quebra linha.
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role}`}>
            <div className="msg__role">
              {m.role === 'user' ? 'você' : 'pixxel'}
              {m.model ? ` · ${m.model}` : ''}
              {m.streaming ? ' · …' : ''}
            </div>
            <div className="msg__content">
              {m.content || (m.streaming ? '…' : '')}
            </div>
          </div>
        ))}
      </div>

      <div className="chat-panel__compose">
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          disabled={!canSend}
          rows={2}
        />
        <button
          type="button"
          className="chat-panel__btn chat-panel__btn--send"
          onClick={send}
          disabled={!draft.trim() || !canSend}
        >
          enviar
        </button>
      </div>

      {dragOver && (
        <div className="chat-panel__drop-overlay">
          solta a imagem ou vídeo pra publicar no Instagram
        </div>
      )}

      {igModal && (
        <div className="ig-modal" onClick={(e) => e.stopPropagation()}>
          <div className="ig-modal__head">
            <span>
              publicar{' '}
              {igModal.file.type.startsWith('video/') ? 'Reel' : 'foto'} no Instagram
            </span>
            <button
              type="button"
              className="chat-panel__btn"
              onClick={closeIgModal}
              aria-label="fechar"
            >
              ×
            </button>
          </div>
          <div className="ig-modal__preview">
            {igModal.file.type.startsWith('video/') ? (
              <video src={igModal.previewUrl} controls />
            ) : (
              <img src={igModal.previewUrl} alt="preview" />
            )}
          </div>
          <textarea
            className="ig-modal__caption"
            placeholder="legenda…"
            value={igModal.caption}
            onChange={(e) =>
              setIgModal({ ...igModal, caption: e.target.value })
            }
            disabled={igModal.status === 'publishing'}
            rows={3}
          />
          {igModal.file.type.startsWith('video/') && (
            <label className="ig-modal__opt">
              <input
                type="checkbox"
                checked={igModal.shareToFeed}
                disabled={igModal.status === 'publishing'}
                onChange={(e) =>
                  setIgModal({ ...igModal, shareToFeed: e.target.checked })
                }
              />
              também mostrar no feed (não só na aba Reels)
            </label>
          )}
          {igModal.message && (
            <div
              className={`ig-modal__msg ig-modal__msg--${igModal.status}`}
            >
              {igModal.status === 'done' ? (
                <a href={igModal.message} target="_blank" rel="noreferrer">
                  ver no Instagram
                </a>
              ) : (
                igModal.message
              )}
            </div>
          )}
          <div className="ig-modal__actions">
            <button
              type="button"
              className="chat-panel__btn"
              onClick={closeIgModal}
            >
              {igModal.status === 'done' ? 'fechar' : 'cancelar'}
            </button>
            {igModal.status !== 'done' && (
              <button
                type="button"
                className="chat-panel__btn chat-panel__btn--send"
                onClick={publishIg}
                disabled={igModal.status === 'publishing'}
              >
                {igModal.status === 'publishing' ? 'publicando…' : 'publicar'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
