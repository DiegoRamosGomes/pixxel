import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ClaudePermissionRequest,
  ClaudeState,
  ClaudeUsage,
  ConnState,
  LiveState,
  RendererEvent,
} from '../shared/ipc.js';
import type { Widget } from '../shared/widgets.js';
import type { ClientCommand } from '@assistant/shared';
import { Orb, type OrbState } from './components/Orb.js';
import { WidgetCard } from './components/widgets/WidgetCard.js';
import { ClaudePanel, type ClaudeMessage } from './components/ClaudePanel.js';
import { ChatPanel } from './components/ChatPanel.js';
import { MemoryGraphPanel } from './components/MemoryGraphPanel.js';
import { CameraPanel } from './components/CameraPanel.js';
import { HandMouseController } from './components/HandMouseController.js';
import { DevicePicker } from './components/DevicePicker.js';
import { useMediaDevices } from './hooks/useMediaDevices.js';
import { ClaudeUsagePill } from './components/ClaudeUsagePill.js';
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
  const [tts, setTts] = useState<TtsState>({ enabled: false, available: false, speaking: false });
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
  const [claudeOpen, setClaudeOpen] = useState(false);
  const [claudeState, setClaudeState] = useState<ClaudeState>({ kind: 'idle' });
  const [claudeMessages, setClaudeMessages] = useState<ClaudeMessage[]>([]);
  const [claudePending, setClaudePending] = useState<ClaudePermissionRequest | null>(null);
  // Fila de tarefas pendentes — espelhada do main via evento `claude_queue`.
  // Renderer NUNCA muta isso direto; só lê. main é a fonte da verdade.
  const [claudeQueue, setClaudeQueue] = useState<string[]>([]);
  const [claudeUsage, setClaudeUsage] = useState<ClaudeUsage | null>(null);
  const [claudeZ, setClaudeZ] = useState(11);
  const [claudeInitialPos, setClaudeInitialPos] = useState({ x: 24, y: 24 });
  const claudeAutoCloseTimerRef = useRef<number | null>(null);
  const [claudeProject, setClaudeProject] = useState<{ path: string; name: string | null }>({
    path: '',
    name: null,
  });
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
  // ID da mensagem assistente do Claude em construção. Mantido em ref pra não
  // causar re-render. Reseta no fim de cada execução.
  const claudeStreamingIdRef = useRef<string | null>(null);

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
        case 'auto_start_live': {
          // Pós-restart via tool restart_app: religa Live sozinho. Mesmo
          // fluxo de onToggleLive mas sem depender da closure.
          void (async () => {
            const res = await window.assistant.liveStart();
            if (!res.ok) {
              setLive({ kind: 'unavailable', reason: res.reason ?? 'falhou ao iniciar' });
              return;
            }
            if (!playerRef.current) {
              playerRef.current = new PcmStreamPlayer(24000);
            }
            await playerRef.current.resume();
          })();
          break;
        }
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
        case 'claude_state':
          setClaudeState(event.state);
          if (
            event.state.kind === 'idle' ||
            event.state.kind === 'done' ||
            event.state.kind === 'error'
          ) {
            claudeStreamingIdRef.current = null;
          }
          if (event.state.kind === 'starting' || event.state.kind === 'running') {
            // Garante painel aberto quando Live (fase 2) disparar via tool —
            // qualquer estado "ativo" cobre o caso do `starting` ter passado
            // batido (timing). Bumpa z pra garantir que vem pra frente, senão
            // fica atrás do ChatPanel que sobe a cada toggle.
            setClaudeOpen(true);
            setClaudeZ((z) => Math.max(z, widgetZRef.current) + 1);
          }
          break;
        case 'claude_text': {
          const id = claudeStreamingIdRef.current;
          if (id) {
            setClaudeMessages((prev) =>
              prev.map((m) =>
                m.id === id && m.kind === 'assistant'
                  ? { ...m, text: m.text + event.delta }
                  : m,
              ),
            );
          } else {
            const newId = crypto.randomUUID();
            claudeStreamingIdRef.current = newId;
            setClaudeMessages((prev) => [
              ...prev,
              { id: newId, kind: 'assistant', text: event.delta, streaming: true },
            ]);
          }
          break;
        }
        case 'claude_tool_use':
          setClaudeOpen(true);
          setClaudeZ((z) => Math.max(z, widgetZRef.current) + 1);
          // Fecha streaming corrente — texto e tool_use vêm em blocos separados
          // num mesmo turno do claude.
          claudeStreamingIdRef.current = null;
          setClaudeMessages((prev) => {
            const updated = prev.map((m) =>
              m.kind === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
            );
            return [
              ...updated,
              {
                id: crypto.randomUUID(),
                kind: 'tool',
                tool: event.tool,
                input: event.input,
              },
            ];
          });
          break;
        case 'claude_permission_request':
          setClaudePending(event.request);
          setClaudeOpen(true);
          // CRÍTICO: bumpa z senão a PermissionCard renderiza atrás do
          // ChatPanel e o usuário não vê — Claude expira em 60s e o pedido
          // fica como "negado por timeout".
          setClaudeZ((z) => Math.max(z, widgetZRef.current) + 1);
          break;
        case 'claude_permission_resolved':
          // Emitido quando a decisão veio por voz (Gemini chamando
          // claude_permission_decide). Garante que o card fecha. O caminho
          // do botão local já limpa direto no handler do click.
          setClaudePending((curr) =>
            curr && curr.requestId === event.requestId ? null : curr,
          );
          break;
        case 'claude_result':
          claudeStreamingIdRef.current = null;
          setClaudeMessages((prev) => {
            const updated = prev.map((m) =>
              m.kind === 'assistant' && m.streaming ? { ...m, streaming: false } : m,
            );
            if (!event.ok) {
              return [
                ...updated,
                { id: crypto.randomUUID(), kind: 'error', text: event.text },
              ];
            }
            return updated;
          });
          break;
        case 'claude_usage':
          setClaudeUsage(event.usage);
          break;
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
        case 'claude_active_project':
          setClaudeProject({ path: event.path, name: event.name });
          break;
        case 'claude_queue':
          setClaudeQueue(event.tasks);
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

  // Auto-close do ClaudePanel: fica aberto enquanto starting/running, e fecha
  // sozinho após `done` (5s pra ler resultado). Em `error`, fica aberto até
  // o usuário fechar.
  useEffect(() => {
    if (claudeAutoCloseTimerRef.current != null) {
      window.clearTimeout(claudeAutoCloseTimerRef.current);
      claudeAutoCloseTimerRef.current = null;
    }
    if (claudeState.kind === 'starting' || claudeState.kind === 'running') {
      // Posiciona no canto superior-esquerdo do orb-pane na primeira abertura
      // (drag posterior preserva a posição até o componente desmontar).
      const pane = orbPaneRef.current;
      if (pane) {
        setClaudeInitialPos({ x: 24, y: 24 });
      }
      setClaudeOpen(true);
    } else if (claudeState.kind === 'done' || claudeState.kind === 'error') {
      // Auto-close só se a fila do main estiver vazia. Se tem mais tarefas
      // pendentes, o main vai disparar a próxima sozinho via tryDequeue.
      // Em error usa janela maior pra dar tempo de ler o motivo.
      if (claudeQueue.length > 0) return;
      const delayMs = claudeState.kind === 'error' ? 10000 : 5000;
      claudeAutoCloseTimerRef.current = window.setTimeout(() => {
        setClaudeOpen(false);
        claudeAutoCloseTimerRef.current = null;
      }, delayMs);
    }
    // idle → não força nada (idle não abre nem fecha)
  }, [claudeState.kind, claudeQueue.length]);

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
    if (live.kind === 'speaking' || tts.speaking) return 'speaking';
    if (live.kind === 'connecting' || awaitingResponse) return 'thinking';
    const lastIsStreaming =
      messages.length > 0 &&
      messages[messages.length - 1].kind === 'text' &&
      (messages[messages.length - 1] as Extract<Message, { kind: 'text' }>).streaming;
    return lastIsStreaming ? 'thinking' : 'idle';
  }, [messages, tts.speaking, awaitingResponse, live.kind]);

  async function send(text: string) {
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

  function onToggleClaude() {
    setClaudeOpen((v) => !v);
  }

  async function onClaudeSend(prompt: string) {
    // Sempre delega pro main. Se Claude tá ocupado, main enfileira e devolve
    // {queued:true,position}. Se idle, dispara já e devolve {ok:true}.
    setClaudeMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), kind: 'user', text: prompt },
    ]);
    const res = await window.assistant.claudeStart(prompt);
    if (!res.ok) {
      setClaudeMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          kind: 'error',
          text: res.reason ?? 'falhou ao iniciar',
        },
      ]);
    }
  }

  async function onClaudeCancel() {
    await window.assistant.claudeCancel();
  }

  async function onClaudeResetSession() {
    await window.assistant.claudeResetSession();
    setClaudeMessages([]);
    claudeStreamingIdRef.current = null;
  }

  function onClaudePermissionDecide(allowed: boolean) {
    if (!claudePending) return;
    window.assistant.claudePermissionResponse(claudePending.requestId, allowed);
    setClaudePending(null);
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
        claudeUsage={claudeUsage}
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

          {claudeOpen && (
            <div
              className="widget-slot widget-slot--claude"
              style={{ zIndex: claudeZ }}
            >
              <ClaudePanel
                state={claudeState}
                messages={claudeMessages}
                project={claudeProject}
                initialX={claudeInitialPos.x}
                initialY={claudeInitialPos.y}
                pending={claudePending}
                queued={claudeQueue.length > 0 ? claudeQueue.join('\n') : null}
                onSend={onClaudeSend}
                onPermissionDecide={onClaudePermissionDecide}
                onCancel={onClaudeCancel}
                onClose={() => setClaudeOpen(false)}
                onResetSession={onClaudeResetSession}
                onActivate={() => setClaudeZ((z) => Math.max(z, widgetZRef.current) + 1)}
              />
            </div>
          )}

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
