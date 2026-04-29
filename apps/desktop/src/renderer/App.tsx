import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConnState, LiveState, RendererEvent } from '../shared/ipc.js';
import type { ClientCommand } from '@assistant/shared';
import { Orb, type OrbState } from './components/Orb.js';
import { startMicCapture, type MicCaptureHandle } from './audio/mic-capture.js';
import { PcmStreamPlayer } from './audio/audio-player.js';

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
  const [live, setLive] = useState<LiveState>({ kind: 'idle' });
  const [micStatus, setMicStatus] = useState<{
    state: 'off' | 'starting' | 'capturing' | 'error';
    info?: string;
  }>({ state: 'off' });
  const scrollRef = useRef<HTMLDivElement>(null);
  const micRef = useRef<MicCaptureHandle | null>(null);
  const playerRef = useRef<PcmStreamPlayer | null>(null);
  const micChunksRef = useRef(0);
  // ID da mensagem em construção pra cada role; reseta quando turno fecha.
  const liveTranscriptIdRef = useRef<{ user?: string; model?: string }>({});

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
        case 'live_state':
          setLive(event.state);
          // Quando o turno do modelo termina (volta pra 'ready') ou tudo morre,
          // fecha as mensagens em construção pra o próximo turno virar entrada nova.
          if (event.state.kind !== 'speaking') {
            liveTranscriptIdRef.current = {};
          }
          if (event.state.kind === 'closed' || event.state.kind === 'error' || event.state.kind === 'idle') {
            void teardownLiveLocal();
          }
          break;
        case 'live_audio':
          playerRef.current?.enqueue(event.pcm);
          break;
        case 'live_transcript': {
          const role = event.role === 'user' ? 'user' : 'assistant';
          const ref = liveTranscriptIdRef.current;
          const existingId = event.role === 'user' ? ref.user : ref.model;
          if (existingId) {
            // Append no já existente
            setMessages((prev) =>
              prev.map((m) =>
                m.id === existingId && m.kind === 'text'
                  ? { ...m, content: m.content + event.text }
                  : m,
              ),
            );
          } else {
            const id = crypto.randomUUID();
            if (event.role === 'user') ref.user = id;
            else ref.model = id;
            setMessages((prev) => [
              ...prev,
              {
                id,
                kind: 'text',
                role,
                content: event.text,
                streaming: true,
                model: event.role === 'model' ? 'gemini-live' : undefined,
              },
            ]);
          }
          break;
        }
      }
    });
    return off;
  }, []);

  async function stopMicLocal() {
    if (micRef.current) {
      await micRef.current.stop();
      micRef.current = null;
    }
    micChunksRef.current = 0;
    setMicStatus({ state: 'off' });
  }

  async function teardownLiveLocal() {
    await stopMicLocal();
    if (playerRef.current) {
      await playerRef.current.close();
      playerRef.current = null;
    }
  }

  async function startMicLocal() {
    if (micRef.current) return;
    setMicStatus({ state: 'starting' });
    try {
      micRef.current = await startMicCapture((pcm) => {
        micChunksRef.current += 1;
        if (micChunksRef.current === 1) {
          setMicStatus({ state: 'capturing', info: '1 chunk' });
        } else if (micChunksRef.current % 25 === 0) {
          setMicStatus({
            state: 'capturing',
            info: `${micChunksRef.current} chunks`,
          });
        }
        window.assistant.liveSendAudio(pcm);
      });
      setMicStatus({ state: 'capturing', info: 'aguardando primeiro chunk…' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'mic indisponível';
      console.warn('[live] mic capture failed:', msg);
      setMicStatus({ state: 'error', info: msg });
    }
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages]);

  const orbState: OrbState = useMemo(() => {
    if (live.kind === 'speaking' || tts.speaking) return 'speaking';
    if (live.kind === 'connecting' || awaitingResponse) return 'thinking';
    const lastIsStreaming =
      messages.length > 0 &&
      messages[messages.length - 1].kind === 'text' &&
      (messages[messages.length - 1] as Extract<Message, { kind: 'text' }>).streaming;
    return lastIsStreaming ? 'thinking' : 'idle';
  }, [messages, tts.speaking, awaitingResponse, live.kind]);

  async function send() {
    const text = draft.trim();
    if (!text) return;

    const liveReady = live.kind === 'ready' || live.kind === 'speaking';
    // Se a sessão Live tá viva, manda pra ela: resposta vem em áudio com a
    // mesma voz da conversa por mic. Senão, cai no pipeline atual (backend/NIM).
    if (!liveReady && conn.state !== 'open') return;

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

    if (liveReady) {
      // Garante que o player está pronto pra tocar a resposta — caso o
      // usuário tenha o Live ligado mas nunca tenha falado nada antes.
      if (!playerRef.current) playerRef.current = new PcmStreamPlayer(24000);
      await playerRef.current.resume();
      const res = await window.assistant.liveSendText(text);
      if (!res.ok) {
        setAwaitingResponse(false);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            kind: 'text',
            role: 'assistant',
            content: `[live error: ${res.reason ?? 'desconhecido'}]`,
            streaming: false,
          },
        ]);
      }
      return;
    }

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

  async function onToggleLive() {
    const isActive =
      live.kind === 'connecting' || live.kind === 'ready' || live.kind === 'speaking';
    if (isActive) {
      await window.assistant.liveStop();
      await teardownLiveLocal();
      return;
    }
    const res = await window.assistant.liveStart();
    if (!res.ok) {
      setLive({ kind: 'unavailable', reason: res.reason ?? 'falhou ao iniciar' });
      return;
    }
    if (!playerRef.current) {
      playerRef.current = new PcmStreamPlayer(24000);
    }
    await playerRef.current.resume();
    // NÃO inicia mic automaticamente — usuário escolhe via botão dedicado.
  }

  async function onToggleMic() {
    const liveReady = live.kind === 'ready' || live.kind === 'speaking';
    if (!liveReady) return;
    if (micRef.current) {
      await stopMicLocal();
    } else {
      await startMicLocal();
    }
  }

  const ttsLabel = !tts.available
    ? '🔇 sem voz'
    : tts.enabled
      ? '🔊 voz ligada'
      : '🔇 voz mudo';

  const liveActive =
    live.kind === 'connecting' || live.kind === 'ready' || live.kind === 'speaking';
  const liveReady = live.kind === 'ready' || live.kind === 'speaking';
  const liveLabel = (() => {
    switch (live.kind) {
      case 'connecting':
        return '⚡ conectando…';
      case 'ready':
        return '⚡ jarvis on';
      case 'speaking':
        return '⚡ falando…';
      case 'unavailable':
        return '⚡ indisponível';
      case 'error':
        return '⚡ erro';
      case 'closed':
        return '⚡ caiu';
      default:
        return '⚡ jarvis off';
    }
  })();
  const liveTitle =
    live.kind === 'unavailable' || live.kind === 'error' || live.kind === 'closed'
      ? `${liveLabel} · ${(live as { reason?: string; message?: string }).reason ?? (live as { message?: string }).message ?? ''}`
      : 'Liga/desliga sessão Gemini Live (texto e voz)';

  const micOn = micStatus.state === 'capturing';
  const micLabel = (() => {
    if (!liveReady) return '🎙 mic';
    switch (micStatus.state) {
      case 'starting':
        return '🎙 ligando…';
      case 'capturing':
        return '🎙 mic on';
      case 'error':
        return '🎙 mic erro';
      default:
        return '🎙 mic off';
    }
  })();
  const micTitle = !liveReady
    ? 'Liga o Jarvis primeiro pra usar o mic'
    : micStatus.state === 'error'
      ? `mic erro: ${micStatus.info ?? '?'}`
      : 'Liga/desliga captura do microfone';

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
            className={`tts-toggle ${liveActive ? 'tts-toggle--on' : ''}`}
            onClick={onToggleLive}
            title={liveTitle}
          >
            {liveLabel}
          </button>
          <button
            type="button"
            className={`tts-toggle ${micOn ? 'tts-toggle--on' : ''}`}
            onClick={onToggleMic}
            disabled={!liveReady}
            title={micTitle}
          >
            {micLabel}
          </button>
          <button
            type="button"
            className={`tts-toggle ${tts.enabled ? 'tts-toggle--on' : ''}`}
            onClick={onToggleTts}
            disabled={!tts.available}
            title={tts.available ? 'Liga/desliga voz local (Piper)' : 'Piper TTS não configurado'}
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
          placeholder={(() => {
            if (live.kind === 'ready' || live.kind === 'speaking') {
              return 'Digite — Jarvis responde por voz…';
            }
            return conn.state === 'open'
              ? 'Digite uma mensagem…'
              : 'Aguardando conexão com o backend…';
          })()}
          disabled={
            conn.state !== 'open' &&
            live.kind !== 'ready' &&
            live.kind !== 'speaking'
          }
          rows={2}
        />
        <button
          type="button"
          onClick={send}
          disabled={
            !draft.trim() ||
            (conn.state !== 'open' &&
              live.kind !== 'ready' &&
              live.kind !== 'speaking')
          }
        >
          enviar
        </button>
      </footer>
    </div>
  );
}
