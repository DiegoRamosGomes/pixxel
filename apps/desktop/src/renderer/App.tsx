import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConnState,
  LiveState,
  RendererEvent,
} from '../shared/ipc.js';
import type { Widget } from '../shared/widgets.js';
import { Orb, type OrbState } from './components/Orb.js';
import { WidgetCard } from './components/widgets/WidgetCard.js';
import { ChatPanel } from './components/ChatPanel.js';
import { MemoryGraphPanel } from './components/MemoryGraphPanel.js';
import { CameraPanel } from './components/CameraPanel.js';
import { HandMouseController } from './components/HandMouseController.js';
import { DevicePicker } from './components/DevicePicker.js';
import { useMediaDevices } from './hooks/useMediaDevices.js';
import { Sidebar } from './components/Sidebar.js';
import { OrbControls } from './components/OrbControls.js';
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
    };

const CONN_LABELS: Record<ConnState, string> = {
  connecting: 'conectando',
  open: 'online',
  closed: 'offline',
  error: 'erro',
};


export function App() {
  const [conn, setConn] = useState<{ state: ConnState; reason?: string }>({
    state: 'connecting',
  });
  const [messages, setMessages] = useState<Message[]>([]);
  const [chatOpen, setChatOpen] = useState(true);
  const [chatZ, setChatZ] = useState(11);
  const [chatInitialPos, setChatInitialPos] = useState({ x: 24, y: 24 });
  const [memGraphOpen, setMemGraphOpen] = useState(false);
  const [memGraphZ, setMemGraphZ] = useState(12);
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraZ, setCameraZ] = useState(13);
  const [handMouseEnabled, setHandMouseEnabled] = useState(false);
  const [handMouseScreen, setHandMouseScreen] = useState<{ width: number; height: number } | null>(null);
  const devices = useMediaDevices();
  const [userPresent, setUserPresent] = useState(true);
  const absentSinceRef = useRef<number | null>(null);
  const [awaitingResponse, setAwaitingResponse] = useState(false);
  const [live, setLive] = useState<LiveState>({ kind: 'idle' });
  const [micStatus, setMicStatus] = useState<{
    state: 'off' | 'starting' | 'capturing' | 'error';
    info?: string;
  }>({ state: 'off' });
  type StackItem = {
    id: string;
    widget: Widget;
    x: number;
    y: number;
    z: number;
  };
  const [widgets, setWidgets] = useState<StackItem[]>([]);
  const [sysMetrics, setSysMetrics] = useState<{
    cpuPercent: number;
    memUsedBytes: number;
    memTotalBytes: number;
  } | null>(null);
  // Histórico de CPU pro sparkline. Mantém últimas N amostras pra renderizar.
  const [cpuHistory, setCpuHistory] = useState<number[]>([]);
  const [topProcesses, setTopProcesses] = useState<{
    topCpu: Array<{ pid: number; name: string; cpu: number; mem: number }>;
    topMem: Array<{ pid: number; name: string; cpu: number; mem: number }>;
  }>({ topCpu: [], topMem: [] });
  const [wifi, setWifi] = useState<{ ssid: string | null; signal: number | null }>({
    ssid: null,
    signal: null,
  });
  const [netBw, setNetBw] = useState<{ rx: number; tx: number }>({ rx: 0, tx: 0 });
  const [rxHistory, setRxHistory] = useState<number[]>([]);
  const [txHistory, setTxHistory] = useState<number[]>([]);
  const orbPaneRef = useRef<HTMLDivElement>(null);
  const micRef = useRef<MicCaptureHandle | null>(null);
  const playerRef = useRef<PcmStreamPlayer | null>(null);
  const micChunksRef = useRef(0);
  const liveTranscriptIdRef = useRef<{ user?: string; model?: string }>({});
  const widgetTimersRef = useRef<Map<string, number>>(new Map());
  // Contadores pra z-index incremental e rotação de cantos.
  const widgetZRef = useRef(10);
  const widgetSpawnIdxRef = useRef(0);

  useEffect(() => {
    const off = window.assistant.onEvent((event: RendererEvent) => {
      switch (event.type) {
        case 'conn':
          setConn({ state: event.state, reason: event.reason });
          break;
        case 'live_state':
          setLive(event.state);
          // Quando o turno do modelo termina (volta pra 'ready') ou tudo morre,
          // fecha as mensagens em construção pra o próximo turno virar entrada nova.
          if (event.state.kind !== 'speaking') {
            liveTranscriptIdRef.current = {};
          }
          // Live foi iniciado pelo main (auto-start), não pelo botão. Cria o
          // player aqui pra garantir que `live_audio` chunks tenham onde tocar.
          // Sem isso, mensagens "no boot" chegam mas saem mudas.
          if (
            (event.state.kind === 'connecting' || event.state.kind === 'ready') &&
            !playerRef.current
          ) {
            playerRef.current = new PcmStreamPlayer(24000);
            void playerRef.current.resume();
          }
          if (event.state.kind === 'closed' || event.state.kind === 'error' || event.state.kind === 'idle') {
            void teardownLiveLocal();
          }
          break;
        case 'live_audio':
          playerRef.current?.enqueue(event.pcm);
          break;
        case 'widget_dismiss': {
          dismissWidget(event.id);
          break;
        }
        case 'widget': {
          const pos = computeSpawnPosition(widgetSpawnIdxRef.current++);
          widgetZRef.current += 1;
          setWidgets((prev) => [
            ...prev,
            {
              id: event.id,
              widget: event.widget,
              x: pos.x,
              y: pos.y,
              z: widgetZRef.current,
            },
          ]);
          const timer = window.setTimeout(() => {
            dismissWidget(event.id);
          }, event.ttlMs);
          widgetTimersRef.current.set(event.id, timer);
          break;
        }
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
        case 'ui_panel':
          if (event.panel === 'chat') {
            setChatOpen(event.open);
            if (event.open) {
              setChatZ((z) => Math.max(z, widgetZRef.current) + 1);
            }
          } else if (event.panel === 'memory_graph') {
            setMemGraphOpen(event.open);
            if (event.open) {
              setMemGraphZ((z) => Math.max(z, widgetZRef.current) + 1);
            }
          } else if (event.panel === 'camera') {
            setCameraOpen(event.open);
            if (event.open) {
              setCameraZ((z) => Math.max(z, widgetZRef.current) + 1);
            } else {
              setUserPresent(true);
            }
          }
          break;
        case 'active_project':
          // Projeto ativo (definido por open_project). Renderer ignora por
          // enquanto — sem UI específica.
          break;
        case 'system_metrics': {
          const snap = {
            cpuPercent: event.cpuPercent,
            memUsedBytes: event.memUsedBytes,
            memTotalBytes: event.memTotalBytes,
          };
          setSysMetrics(snap);
          // Mantém últimas 40 amostras (~60s a cada 1.5s) pro sparkline.
          setCpuHistory((prev) => {
            const next = [...prev, event.cpuPercent];
            return next.length > 40 ? next.slice(next.length - 40) : next;
          });
          break;
        }
        case 'top_processes':
          setTopProcesses({ topCpu: event.topCpu, topMem: event.topMem });
          break;
        case 'wifi_info':
          setWifi({ ssid: event.ssid, signal: event.signal });
          break;
        case 'network_bw': {
          setNetBw({ rx: event.rxBytesPerSec, tx: event.txBytesPerSec });
          setRxHistory((prev) => {
            const next = [...prev, event.rxBytesPerSec];
            return next.length > 40 ? next.slice(next.length - 40) : next;
          });
          setTxHistory((prev) => {
            const next = [...prev, event.txBytesPerSec];
            return next.length > 40 ? next.slice(next.length - 40) : next;
          });
          break;
        }
      }
    });
    return off;
  }, []);

  // Posiciona o chat-widget no canto direito do orb-pane na 1ª montagem.
  useEffect(() => {
    const pane = orbPaneRef.current;
    if (!pane) return;
    const widgetW = Math.min(440, pane.clientWidth * 0.7);
    setChatInitialPos({
      x: Math.max(24, pane.clientWidth - widgetW - 24),
      y: 24,
    });
  }, []);

  function dismissWidget(id: string) {
    setWidgets((prev) => prev.filter((w) => w.id !== id));
    const t = widgetTimersRef.current.get(id);
    if (t != null) {
      window.clearTimeout(t);
      widgetTimersRef.current.delete(id);
    }
  }

  function activateWidget(id: string) {
    widgetZRef.current += 1;
    const z = widgetZRef.current;
    setWidgets((prev) => prev.map((w) => (w.id === id ? { ...w, z } : w)));
  }

  // Rotaciona spawn entre 4 cantos do orb-pane com pequeno stagger pra
  // várias respostas seguidas não cairem no mesmo lugar.
  function computeSpawnPosition(idx: number): { x: number; y: number } {
    const pane = orbPaneRef.current;
    const w = pane?.clientWidth ?? 800;
    const h = pane?.clientHeight ?? 600;
    const widgetW = Math.min(360, w * 0.36);
    const widgetH = 200; // estimativa — só usado pra colocar perto do canto
    const margin = 24;
    const stagger = 28;
    const stage = Math.floor(idx / 4);
    const corner = idx % 4;
    const off = stage * stagger;
    switch (corner) {
      case 0:
        return { x: w - widgetW - margin - off, y: margin + off };
      case 1:
        return { x: margin + off, y: margin + off };
      case 2:
        return { x: w - widgetW - margin - off, y: h - widgetH - margin - off };
      case 3:
        return { x: margin + off, y: h - widgetH - margin - off };
      default:
        return { x: margin, y: margin };
    }
  }

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
      }, devices.selectedAudioId);
      setMicStatus({ state: 'capturing', info: 'aguardando primeiro chunk…' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'mic indisponível';
      console.warn('[live] mic capture failed:', msg);
      setMicStatus({ state: 'error', info: msg });
    }
  }

  // "Welcome back" — quando o usuário some por mais de 1 minuto e volta,
  // pede pro Live disparar uma saudação leve. Só roda com a câmera aberta
  // (a presença vem dela) e a sessão Live pronta.
  const ABSENT_GREET_MS = 60_000;
  useEffect(() => {
    if (!cameraOpen) {
      absentSinceRef.current = null;
      return;
    }
    if (!userPresent) {
      if (absentSinceRef.current === null) {
        absentSinceRef.current = Date.now();
      }
      return;
    }
    // userPresent === true
    const since = absentSinceRef.current;
    if (since === null) return;
    const elapsed = Date.now() - since;
    absentSinceRef.current = null;
    if (elapsed < ABSENT_GREET_MS) return;
    const liveReady = live.kind === 'ready' || live.kind === 'speaking';
    if (!liveReady) return;
    const minutes = Math.max(1, Math.round(elapsed / 60_000));
    void window.assistant.liveSendText(
      `[evento interno — não é fala do usuário] O usuário voltou pra frente da ` +
        `câmera após ~${minutes} minuto(s) ausente. Cumprimente em UMA frase ` +
        `curta, leve e natural em pt-BR (ex: "que bom que voltou", "ei, ` +
        `sumido", "voltou!"). NÃO pergunte nada, só saudação. NÃO chame tools.`,
    );
  }, [userPresent, cameraOpen, live.kind]);

  const orbState: OrbState = useMemo(() => {
    if (live.kind === 'speaking') return 'speaking';
    if (live.kind === 'connecting' || awaitingResponse) return 'thinking';
    const lastIsStreaming =
      messages.length > 0 &&
      messages[messages.length - 1].kind === 'text' &&
      (messages[messages.length - 1] as Extract<Message, { kind: 'text' }>).streaming;
    return lastIsStreaming ? 'thinking' : 'idle';
  }, [messages, awaitingResponse, live.kind]);

  async function send(text: string) {
    if (!text) return;

    const liveReady = live.kind === 'ready' || live.kind === 'speaking';
    // Texto vai pra mesma sessão de voz na API: a resposta vem em áudio.
    if (!liveReady) return;

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

  const liveActive =
    live.kind === 'connecting' || live.kind === 'ready' || live.kind === 'speaking';
  const liveReady = live.kind === 'ready' || live.kind === 'speaking';
  const liveLabel = (() => {
    switch (live.kind) {
      case 'connecting':
        return '⚡ conectando…';
      case 'ready':
        return '⚡ pixxel on';
      case 'speaking':
        return '⚡ falando…';
      case 'unavailable':
        return '⚡ indisponível';
      case 'error':
        return '⚡ erro';
      case 'closed':
        return '⚡ caiu';
      default:
        return '⚡ pixxel off';
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
    ? 'Liga o Pixxel primeiro pra usar o mic'
    : micStatus.state === 'error'
      ? `mic erro: ${micStatus.info ?? '?'}`
      : 'Liga/desliga captura do microfone';

  return (
    <div className="app">
      <Sidebar
        metrics={sysMetrics}
        cpuHistory={cpuHistory}
        topProcesses={topProcesses}
        wifi={wifi}
        netBw={netBw}
        rxHistory={rxHistory}
        txHistory={txHistory}
      />
      <header>
        <div className="brand">
          <span className="brand-dot" />
          pixxel
        </div>
        <div className="header-right">
          <span className={`conn conn--${conn.state}`}>
            {CONN_LABELS[conn.state]}
            {conn.reason && conn.state !== 'open' ? ` · ${conn.reason}` : ''}
          </span>
          <div className="window-controls">
            <DevicePicker devices={devices} />
            <button
              type="button"
              className={`winbtn${handMouseEnabled ? ' winbtn--active' : ''}`}
              onClick={async () => {
                if (handMouseEnabled) {
                  setHandMouseEnabled(false);
                  setHandMouseScreen(null);
                  await window.assistant.handMouseDisable();
                } else {
                  const r = await window.assistant.handMouseEnable();
                  if (!r.ok || !r.screen) {
                    console.warn('[hand-mouse] enable falhou:', r.reason);
                    return;
                  }
                  setHandMouseScreen(r.screen);
                  setHandMouseEnabled(true);
                }
              }}
              title={handMouseEnabled ? 'Desligar mouse por gestos' : 'Ligar mouse por gestos (pinch = clique)'}
              aria-label="Mouse por gestos"
            >
              ✋
            </button>
            <button
              type="button"
              className="winbtn"
              onClick={() => window.assistant.windowMinimize()}
              title="Minimizar"
              aria-label="Minimizar"
            >
              –
            </button>
            <button
              type="button"
              className="winbtn"
              onClick={() => window.assistant.windowMaximizeToggle()}
              title="Maximizar/Restaurar"
              aria-label="Maximizar"
            >
              ▢
            </button>
            <button
              type="button"
              className="winbtn winbtn--close"
              onClick={() => window.assistant.windowClose()}
              title="Fechar"
              aria-label="Fechar"
            >
              ×
            </button>
          </div>
        </div>
      </header>

      <main>
        <div className="orb-pane" ref={orbPaneRef}>
          <Orb state={orbState} present={userPresent} />
          <OrbControls
            live={live}
            micState={micStatus.state}
            micEnabled={live.kind === 'ready' || live.kind === 'speaking'}
            chatOpen={chatOpen}
            onToggleLive={onToggleLive}
            onToggleMic={onToggleMic}
            onToggleChat={() => {
              setChatOpen((v) => !v);
              setChatZ((z) => Math.max(z, widgetZRef.current) + 1);
            }}
          />
          {widgets.map((w) => (
            <div
              key={w.id}
              className="widget-slot"
              style={{ zIndex: w.z }}
            >
              <WidgetCard
                widget={w.widget}
                initialX={w.x}
                initialY={w.y}
                onDismiss={() => dismissWidget(w.id)}
                onActivate={() => activateWidget(w.id)}
              />
            </div>
          ))}

          {memGraphOpen && (
            <div
              className="widget-slot widget-slot--memgraph"
              style={{ zIndex: memGraphZ }}
            >
              <MemoryGraphPanel
                initialX={120}
                initialY={80}
                onClose={() => setMemGraphOpen(false)}
                onActivate={() => setMemGraphZ((z) => Math.max(z, widgetZRef.current) + 1)}
              />
            </div>
          )}

          <HandMouseController
            enabled={handMouseEnabled}
            screen={handMouseScreen}
            videoDeviceId={devices.selectedVideoId}
          />

          {cameraOpen && (
            <div
              className="widget-slot widget-slot--camera"
              style={{ zIndex: cameraZ }}
            >
              <CameraPanel
                initialX={180}
                initialY={120}
                onClose={() => setCameraOpen(false)}
                onActivate={() => setCameraZ((z) => Math.max(z, widgetZRef.current) + 1)}
                onPresenceChange={setUserPresent}
                videoDeviceId={devices.selectedVideoId}
              />
            </div>
          )}

          {chatOpen && (
            <div
              className="widget-slot widget-slot--chat"
              style={{ zIndex: chatZ }}
            >
              <ChatPanel
                messages={messages}
                conn={conn.state}
                live={live}
                initialX={chatInitialPos.x}
                initialY={chatInitialPos.y}
                onSend={send}
                onClose={() => setChatOpen(false)}
                onActivate={() => setChatZ((z) => Math.max(z, widgetZRef.current) + 1)}
              />
            </div>
          )}
        </div>
      </main>

    </div>
  );
}
