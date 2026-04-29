import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnState, RendererEvent } from '../shared/ipc.js';
import type { ClientCommand } from '@assistant/shared';
import { Orb, type OrbState } from './components/Orb.js';

type Role = 'user' | 'assistant';

type Message =
  | {
      id: string;
      kind: 'text';
      role: Role;
      content: string;
      streaming: boolean;
      model?: string;
    }
  | {
      id: string;
      kind: 'command';
      role: 'assistant';
      command: ClientCommand;
      spokenLabel: string;
      source: 'regex' | 'llm';
      executed?: { ok: boolean; reason?: string };
    };

const CONN_LABELS: Record<ConnState, string> = {
  connecting: 'conectando',
  open: 'online',
  closed: 'offline',
  error: 'erro',
};

type TtsState = { enabled: boolean; available: boolean; speaking: boolean };

export function App() {
  const [conn, setConn] = useState<{ state: ConnState; reason?: string }>({
    state: 'connecting',
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [tts, setTts] = useState<TtsState>({ enabled: false, available: false, speaking: false });
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = window.assistant.onEvent((event: RendererEvent) => {
      switch (event.type) {
        case 'conn':
          setConn({ state: event.state, reason: event.reason });
          break;
        case 'assistant_start':
          setAwaitingResponse(false);
          setMessages((prev) => [
            ...prev,
            {
              id: event.messageId,
              kind: 'text',
              role: 'assistant',
              content: '',
              streaming: true,
              model: event.model,
            },
          ]);
          break;
        case 'assistant_chunk':
          setAwaitingResponse(false);
          setMessages((prev) => {
            const exists = prev.some((m) => m.id === event.messageId);
            if (!exists) {
              return [
                ...prev,
                {
                  id: event.messageId,
                  kind: 'text',
                  role: 'assistant',
                  content: event.delta,
                  streaming: true,
                },
              ];
            }
            return prev.map((m) =>
              m.id === event.messageId && m.kind === 'text'
                ? { ...m, content: m.content + event.delta }
                : m,
            );
          });
          break;
        case 'assistant_done':
          setMessages((prev) => {
            const exists = prev.some((m) => m.id === event.messageId);
            if (!exists) {
              return [
                ...prev,
                {
                  id: event.messageId,
                  kind: 'text',
                  role: 'assistant',
                  content: event.fullText || '(sem resposta)',
                  streaming: false,
                },
              ];
            }
            return prev.map((m) =>
              m.id === event.messageId && m.kind === 'text'
                ? { ...m, content: event.fullText, streaming: false }
                : m,
            );
          });
          break;
        case 'assistant_command':
          setAwaitingResponse(false);
          setMessages((prev) => [
            ...prev,
            {
              id: event.messageId,
              kind: 'command',
              role: 'assistant',
              command: event.command,
              spokenLabel: event.spokenLabel,
              source: event.source,
              executed: event.executed,
            },
          ]);
          break;
        case 'assistant_error':
          setAwaitingResponse(false);
          setMessages((prev) => [
            ...prev,
            {
              id: crypto.randomUUID(),
              kind: 'text',
              role: 'assistant',
              content: `[erro: ${event.code}] ${event.message}`,
              streaming: false,
            },
          ]);
          break;
        case 'tts_state':
          setTts((prev) => ({ ...prev, enabled: event.enabled, available: event.available }));
          break;
        case 'tts_speaking':
          setTts((prev) => ({ ...prev, speaking: event.speaking }));
          break;
      }
    });
    return off;
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  const orbState: OrbState = useMemo(() => {
    if (tts.speaking) return 'speaking';
    if (awaitingResponse) return 'thinking';
    const lastIsStreaming =
      messages.length > 0 &&
      messages[messages.length - 1].kind === 'text' &&
      (messages[messages.length - 1] as Extract<Message, { kind: 'text' }>).streaming;
    return lastIsStreaming ? 'thinking' : 'idle';
  }, [messages, tts.speaking, awaitingResponse]);

  async function send() {
    const text = draft.trim();
    if (!text || conn.state !== 'open') return;
    setMessages((prev) => [
      ...prev,
      {
        id: crypto.randomUUID(),
        kind: 'text',
        role: 'user',
        content: text,
        streaming: false,
      },
    ]);
    setDraft('');
    setAwaitingResponse(true);
    await window.assistant.sendText(text);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  async function onToggleTts() {
    const next = await window.assistant.toggleTts();
    setTts((prev) => ({ ...prev, ...next }));
  }

  const ttsLabel = !tts.available
    ? '🔇 sem voz'
    : tts.enabled
      ? '🔊 voz ligada'
      : '🔇 voz mudo';

  return (
    <div className="app">
      <header>
        <div className="brand">
          <span className="brand-dot" />
          jarvis
        </div>
        <div className="header-right">
          <button
            type="button"
            className={`tts-toggle ${tts.enabled ? 'tts-toggle--on' : ''}`}
            onClick={onToggleTts}
            disabled={!tts.available}
            title={tts.available ? 'Liga/desliga voz' : 'Piper TTS não configurado'}
          >
            {ttsLabel}
          </button>
          <span className={`conn conn--${conn.state}`}>
            {CONN_LABELS[conn.state]}
            {conn.reason && conn.state !== 'open' ? ` · ${conn.reason}` : ''}
          </span>
        </div>
      </header>

      <main>
        <div className="orb-pane">
          <Orb state={orbState} />
        </div>

        <div className="chat-pane">
          <div className="history" ref={scrollRef}>
            {messages.length === 0 && (
              <p className="empty">
                Diga oi pra começar. Enter envia, Shift+Enter quebra linha.
              </p>
            )}
            {messages.map((m) =>
              m.kind === 'text' ? (
                <div key={m.id} className={`msg msg--${m.role}`}>
                  <div className="msg__role">
                    {m.role === 'user' ? 'você' : 'jarvis'}
                    {m.model ? ` · ${m.model}` : ''}
                    {m.streaming ? ' · …' : ''}
                  </div>
                  <div className="msg__content">
                    {m.content || (m.streaming ? '…' : '')}
                  </div>
                </div>
              ) : (
                <div key={m.id} className="msg msg--cmd">
                  <div className="msg__role">
                    jarvis · ação · {m.source}
                    {m.executed
                      ? m.executed.ok
                        ? ' · ok'
                        : ' · falhou'
                      : ' · executando…'}
                  </div>
                  <div className="msg__content">
                    <strong>{m.spokenLabel}</strong>
                    <span className="cmd-detail">{JSON.stringify(m.command)}</span>
                    {m.executed && !m.executed.ok && m.executed.reason && (
                      <div className="cmd-error">{m.executed.reason}</div>
                    )}
                  </div>
                </div>
              ),
            )}
          </div>
        </div>
      </main>

      <footer>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            conn.state === 'open'
              ? 'Digite uma mensagem…'
              : 'Aguardando conexão com o backend…'
          }
          disabled={conn.state !== 'open'}
          rows={2}
        />
        <button
          type="button"
          onClick={send}
          disabled={conn.state !== 'open' || !draft.trim()}
        >
          enviar
        </button>
      </footer>
    </div>
  );
}
