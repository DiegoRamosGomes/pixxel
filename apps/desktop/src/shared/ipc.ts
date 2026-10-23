import type { ClientCommand } from '@assistant/shared';
import type { Widget } from './widgets.js';

export type { Widget } from './widgets.js';

export type ConnState = 'connecting' | 'open' | 'closed' | 'error';

export type LiveState =
  | { kind: 'idle' }
  | { kind: 'unavailable'; reason: string }
  | { kind: 'connecting' }
  | { kind: 'ready' }
  | { kind: 'speaking' }
  | { kind: 'error'; code: string; message: string }
  | { kind: 'closed'; reason: string };

export type RendererEvent =
  | { type: 'conn'; state: ConnState; reason?: string }
  | { type: 'assistant_start'; messageId: string; model: string }
  | { type: 'assistant_chunk'; messageId: string; delta: string }
  | { type: 'assistant_done'; messageId: string; fullText: string }
  | {
      type: 'assistant_command';
      messageId: string;
      command: ClientCommand;
      spokenLabel: string;
      source: 'regex' | 'llm';
      executed: { ok: boolean; reason?: string };
    }
  | { type: 'assistant_error'; code: string; message: string }
  | { type: 'live_state'; state: LiveState }
  | { type: 'auto_start_live' }
  | { type: 'live_audio'; pcm: ArrayBuffer; sampleRate: number }
  | { type: 'live_transcript'; role: 'user' | 'model'; text: string }
  | { type: 'widget'; id: string; widget: Widget; ttlMs: number }
  | { type: 'widget_dismiss'; id: string }
  | { type: 'active_project'; path: string; name: string | null }
  | { type: 'ui_panel'; panel: 'chat' | 'memory_graph' | 'camera'; open: boolean }
  | { type: 'request_camera_frame'; requestId: string }
  | {
      type: 'system_metrics';
      cpuPercent: number;
      memUsedBytes: number;
      memTotalBytes: number;
    }
  | {
      type: 'top_processes';
      topCpu: Array<{ pid: number; name: string; cpu: number; mem: number }>;
      topMem: Array<{ pid: number; name: string; cpu: number; mem: number }>;
    }
  | {
      type: 'wifi_info';
      ssid: string | null;
      signal: number | null;
    }
  | {
      type: 'network_bw';
      rxBytesPerSec: number;
      txBytesPerSec: number;
    };

export type AssistantApi = {
  sendText: (text: string) => Promise<void>;
  liveStart: () => Promise<{ ok: boolean; reason?: string }>;
  liveStop: () => Promise<void>;
  liveSendAudio: (pcm16k: ArrayBuffer) => void;
  liveSendText: (text: string) => Promise<{ ok: boolean; reason?: string }>;
  liveEndTurn: () => void;
  windowClose: () => void;
  windowMinimize: () => void;
  windowMaximizeToggle: () => void;
  memoryGraph: () => Promise<{
    nodes: Array<{ id: string; label: string; type: 'user' | 'feedback' | 'project' | 'reference' | 'hub'; description?: string }>;
    edges: Array<{ source: string; target: string; kind: 'link' | 'type' }>;
  }>;
  /** Renderer manda o frame da câmera (data URL JPEG) ou null se falhou/sem stream. */
  cameraFrame: (requestId: string, dataUrl: string | null) => void;
  /** Hand-mouse: liga/desliga o tracking. Retorna ok=false se xdotool não tá disponível. */
  handMouseEnable: () => Promise<{ ok: boolean; reason?: string; screen?: { width: number; height: number } }>;
  handMouseDisable: () => Promise<void>;
  /** Hand-mouse: move/click/drag. IPC unidirecional pra latência mínima. */
  handMouseMove: (x: number, y: number) => void;
  handMouseClick: (button: 1 | 2 | 3) => void;
  handMouseDown: (button: 1 | 2 | 3) => void;
  handMouseUp: (button: 1 | 2 | 3) => void;
  handMouseScroll: (direction: 'up' | 'down', ticks?: number) => void;
  /** Pede pro Gemini explicar uma task ClickUp (chama clickup_explain_task). */
  explainClickupTask: (taskId: string) => void;
  /** Publica imagem/vídeo no Instagram. file vem como bytes + nome (ext define tipo).
   *  shareToFeed: para Reels, duplica no feed principal (default false). */
  instagramPublish: (
    fileBytes: ArrayBuffer,
    fileName: string,
    caption: string,
    shareToFeed?: boolean,
  ) => Promise<{ ok: boolean; reason?: string; permalink?: string }>;
  onEvent: (handler: (e: RendererEvent) => void) => () => void;
};

declare global {
  interface Window {
    assistant: AssistantApi;
  }
}
