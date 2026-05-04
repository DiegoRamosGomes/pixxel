import type { LiveState } from '../../shared/ipc.js';

type MicState = 'off' | 'starting' | 'capturing' | 'error';

type Props = {
  live: LiveState;
  micState: MicState;
  micEnabled: boolean;
  chatOpen: boolean;
  onToggleLive: () => void;
  onToggleMic: () => void;
  onToggleChat: () => void;
};

function liveTone(live: LiveState): 'on' | 'off' | 'warn' | 'err' {
  switch (live.kind) {
    case 'ready':
    case 'speaking':
      return 'on';
    case 'connecting':
      return 'warn';
    case 'error':
    case 'unavailable':
    case 'closed':
      return 'err';
    default:
      return 'off';
  }
}

function micTone(s: MicState): 'on' | 'off' | 'warn' | 'err' {
  switch (s) {
    case 'capturing':
      return 'on';
    case 'starting':
      return 'warn';
    case 'error':
      return 'err';
    default:
      return 'off';
  }
}

export function OrbControls({
  live,
  micState,
  micEnabled,
  chatOpen,
  onToggleLive,
  onToggleMic,
  onToggleChat,
}: Props) {
  const lt = liveTone(live);
  const mt = micTone(micState);
  const liveTitle = (() => {
    switch (live.kind) {
      case 'connecting':
        return 'Conectando…';
      case 'ready':
        return 'Pixxel online — clica pra desligar';
      case 'speaking':
        return 'Pixxel falando…';
      case 'unavailable':
        return `Indisponível: ${live.reason ?? '?'}`;
      case 'error':
        return `Erro: ${live.message ?? '?'}`;
      case 'closed':
        return 'Conexão caiu — clica pra religar';
      default:
        return 'Liga o Pixxel (Gemini Live)';
    }
  })();

  return (
    <div className="orb-controls">
      <button
        type="button"
        className={`orb-ctrl orb-ctrl--${lt}`}
        onClick={onToggleLive}
        title={liveTitle}
        aria-label="Live"
      >
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="7" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      </button>

      <button
        type="button"
        className={`orb-ctrl orb-ctrl--${mt}`}
        onClick={onToggleMic}
        disabled={!micEnabled}
        title={
          !micEnabled
            ? 'Liga o Pixxel primeiro'
            : micState === 'capturing'
              ? 'Mic ligado — clica pra desligar'
              : micState === 'error'
                ? 'Mic erro — clica pra tentar de novo'
                : 'Liga o microfone'
        }
        aria-label="Microfone"
      >
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0" />
          <line x1="12" y1="18" x2="12" y2="22" />
        </svg>
      </button>

      <button
        type="button"
        className={`orb-ctrl orb-ctrl--${chatOpen ? 'on' : 'off'}`}
        onClick={onToggleChat}
        title={chatOpen ? 'Fechar chat' : 'Abrir chat'}
        aria-label="Chat"
      >
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6h16v10H8l-4 4V6z" />
          <line x1="8" y1="10" x2="16" y2="10" />
          <line x1="8" y1="13" x2="13" y2="13" />
        </svg>
      </button>
    </div>
  );
}
