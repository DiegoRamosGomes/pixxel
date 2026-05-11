import { useEffect, useRef } from 'react';
import type {
  ClaudeQuestion,
  ClaudeSessionChunk,
  ClaudeSessionStatus,
  ClaudeSessionView,
} from '../../shared/ipc.js';

export interface SessionView extends ClaudeSessionView {
  chunks: ClaudeSessionChunk[];
  finalText?: string;
  pendingPlan?: string;
  pendingQuestion?: ClaudeQuestion;
}

export interface ClaudeSessionWidgetProps {
  session: SessionView;
  onDismiss: (sessionId: string) => void;
}

const STATUS_LABEL: Record<ClaudeSessionStatus, string> = {
  running: 'rodando',
  done: 'concluído',
  paused: 'pausado',
  crashed: 'caiu',
  failed: 'falhou',
  awaiting_approval: 'aguardando plano',
  awaiting_user_input: 'aguardando resposta',
};

const STATUS_COLOR: Record<ClaudeSessionStatus, string> = {
  running: '#3b82f6',
  done: '#16a34a',
  paused: '#f59e0b',
  crashed: '#ef4444',
  failed: '#ef4444',
  awaiting_approval: '#a855f7',
  awaiting_user_input: '#06b6d4',
};

export function ClaudeSessionWidget({ session, onDismiss }: ClaudeSessionWidgetProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [session.chunks.length]);

  const project = session.project ?? '(default)';
  const startedAt = new Date(session.createdAt).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div className="claude-session">
      <header className="claude-session__head">
        <span
          className="claude-session__dot"
          style={{ background: STATUS_COLOR[session.status] }}
          title={STATUS_LABEL[session.status]}
        />
        <span className="claude-session__project">{project}</span>
        <span className="claude-session__time">{startedAt}</span>
        <button
          type="button"
          className="claude-session__close"
          onClick={() => onDismiss(session.sessionId)}
          aria-label="fechar"
        >
          ×
        </button>
      </header>
      <div className="claude-session__task" title={session.taskDescription}>
        {session.taskDescription}
      </div>
      <div className="claude-session__stream" ref={scrollRef}>
        {session.chunks.length === 0 && session.status === 'running' && (
          <div className="claude-session__placeholder">aguardando output…</div>
        )}
        {session.chunks.map((chunk, i) => (
          <ChunkLine key={i} chunk={chunk} />
        ))}
        {session.status === 'awaiting_approval' && session.pendingPlan && (
          <div className="claude-session__plan">
            <div className="claude-session__plan-label">plano (aguardando aprovação)</div>
            {session.pendingPlan}
          </div>
        )}
        {session.status === 'awaiting_user_input' && session.pendingQuestion && (
          <div className="claude-session__question">
            <div className="claude-session__question-label">pergunta (aguardando resposta)</div>
            <div className="claude-session__question-text">{session.pendingQuestion.question}</div>
            <ul className="claude-session__question-options">
              {session.pendingQuestion.options.map((opt, i) => (
                <li key={i}>
                  <strong>{opt.label}</strong>
                  {opt.description ? <span> — {opt.description}</span> : null}
                </li>
              ))}
            </ul>
          </div>
        )}
        {session.finalText && session.status === 'done' && (
          <div className="claude-session__final">{session.finalText}</div>
        )}
      </div>
    </div>
  );
}

function ChunkLine({ chunk }: { chunk: ClaudeSessionChunk }) {
  if (chunk.kind === 'tool_use') {
    return <div className="claude-session__tool">→ {chunk.text}</div>;
  }
  if (chunk.kind === 'tool_result') {
    return <div className="claude-session__tool-result">{chunk.text}</div>;
  }
  if (chunk.kind === 'error') {
    return <div className="claude-session__error">⚠ {chunk.text}</div>;
  }
  return <div className="claude-session__assistant">{chunk.text}</div>;
}
