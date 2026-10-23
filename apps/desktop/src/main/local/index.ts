// Operações que só a máquina local sabe fazer. A API pede via
// local_tool_call e o ApiClient chama executeLocalOp; o resultado volta pro
// Gemini como resposta da tool.

import { LOCAL_OPS, type LocalOp, type LocalToolResult } from '@assistant/shared';
import type { RendererEvent } from '../../shared/ipc.js';
import { openApp, openUrl } from './apps.js';
import { mediaControl, MEDIA_OPS, type MediaOp } from './media.js';
import {
  clickMouse,
  doubleClickMouse,
  inputUnavailableReason,
  keyPress,
  moveMouse,
  typeText,
  type MouseUnit,
} from './input.js';
import { openProject } from './projects.js';
import { restartWifi } from './wifi.js';
import { requestFrame } from './camera.js';
import { deviceStatus, deviceStorage } from './device.js';
import { restartApp } from './restart.js';

export type LocalContext = {
  emit(e: RendererEvent): void;
  setActiveProject(path: string, name: string | null): void;
};

/** Sem Linux/macOS só dá pra abrir URL, painéis, câmera e métricas. */
const PORTABLE_OPS: LocalOp[] = [
  'open_url',
  'open_chat',
  'show_memory',
  'open_camera',
  'camera_frame',
  'device_status',
  'device_storage',
];

export function supportedLocalOps(platform: NodeJS.Platform = process.platform): LocalOp[] {
  if (platform === 'linux' || platform === 'darwin') return [...LOCAL_OPS];
  return [...PORTABLE_OPS];
}

const PANELS = {
  open_chat: { panel: 'chat', opened: 'Chat aberto.', closed: 'Chat fechado.' },
  show_memory: { panel: 'memory_graph', opened: undefined, closed: undefined },
  open_camera: { panel: 'camera', opened: 'Câmera aberta.', closed: 'Câmera fechada.' },
} as const;

const RESTART_DELAY_MS = 1500;

async function inputOp(action: () => Promise<void>, text: string): Promise<LocalToolResult> {
  const unavailable = await inputUnavailableReason();
  if (unavailable) return { ok: false, reason: unavailable };
  try {
    await action();
    return { ok: true, text };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `controle de mouse/teclado falhou: ${msg}` };
  }
}

export async function executeLocalOp(
  op: LocalOp,
  args: Record<string, unknown>,
  ctx: LocalContext,
): Promise<LocalToolResult> {
  switch (op) {
    case 'open_app':
      return openApp(String(args.name ?? '').trim());

    case 'open_url':
      return openUrl(String(args.url ?? ''));

    case 'media_control': {
      const opArg = String(args.op ?? 'play_pause');
      if (!MEDIA_OPS.includes(opArg as MediaOp)) {
        return { ok: false, reason: `operação de mídia inválida: ${opArg}` };
      }
      return mediaControl(opArg as MediaOp);
    }

    case 'open_project': {
      const query = String(args.query ?? '').trim();
      if (!query) return { ok: false, reason: 'query vazia' };
      const r = await openProject(query);
      if (r.ok) {
        ctx.setActiveProject(r.project.path, r.project.name);
        return { ok: true, text: r.text, meta: { projectPath: r.project.path, projectName: r.project.name } };
      }
      // Sem match — devolve alternativas pro Gemini ler/escolher.
      const alts = r.alternatives ?? [];
      const altText = alts.length ? ` Projetos disponíveis: ${alts.map((a) => a.name).join(', ')}.` : '';
      return { ok: false, reason: r.reason + altText };
    }

    case 'desktop_mouse': {
      const x = Number(args.x ?? 0);
      const y = Number(args.y ?? 0);
      const unit = (args.unit as MouseUnit | undefined) ?? 'pixel';
      const action = (args.action as string | undefined) ?? 'move';
      return inputOp(async () => {
        await moveMouse(x, y, unit);
        if (action === 'click') await clickMouse(1);
        else if (action === 'right_click') await clickMouse(3);
        else if (action === 'double_click') await doubleClickMouse();
      }, `Mouse: ${action} em ${x},${y} (${unit}).`);
    }

    case 'desktop_type': {
      const text = String(args.text ?? '');
      if (!text) return { ok: false, reason: 'text vazio' };
      return inputOp(() => typeText(text), 'Digitei.');
    }

    case 'desktop_key': {
      const combo = String(args.combo ?? '').trim();
      if (!combo) return { ok: false, reason: 'combo vazio' };
      return inputOp(() => keyPress(combo), `Tecla: ${combo}.`);
    }

    case 'restart_wifi': {
      const r = await restartWifi();
      if (!r.ok) return { ok: false, reason: r.reason };
      const text = r.ssid
        ? `WiFi reiniciado, conectado em ${r.ssid}${r.signal != null ? ` (sinal ${r.signal}%)` : ''}.`
        : r.connected
          ? 'WiFi reiniciado e reconectado.'
          : 'WiFi reiniciado, mas ainda não reconectou — pode levar mais alguns segundos.';
      return { ok: true, text };
    }

    case 'restart_app':
      // Dá um respiro pro Gemini falar o aviso antes de derrubar o processo.
      setTimeout(restartApp, RESTART_DELAY_MS);
      return { ok: true, text: 'Reiniciando agora — já volto e reconecto sozinho.' };

    case 'open_chat':
    case 'show_memory':
    case 'open_camera': {
      const open = args.open === undefined ? true : Boolean(args.open);
      const p = PANELS[op];
      ctx.emit({ type: 'ui_panel', panel: p.panel, open });
      const text = open ? p.opened : p.closed;
      return text ? { ok: true, text } : { ok: true };
    }

    case 'camera_frame': {
      const timeoutMs = Number(args.timeoutMs ?? 6000);
      const dataUrl = await requestFrame(ctx.emit, timeoutMs);
      return dataUrl ? { ok: true, meta: { dataUrl } } : { ok: false, reason: 'Câmera não respondeu.' };
    }

    case 'device_status':
      return deviceStatus();

    case 'device_storage':
      return deviceStorage(args.mount ? String(args.mount) : '/');
  }
}
