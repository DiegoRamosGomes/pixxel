// Pede um frame da câmera à janela (o CameraPanel captura e devolve via IPC).

import { randomUUID } from 'node:crypto';
import type { RendererEvent } from '../../shared/ipc.js';

const pending = new Map<string, (dataUrl: string | null) => void>();

/** Chamado pelo handler IPC quando a janela entrega o frame. */
export function deliverFrame(requestId: string, dataUrl: string | null): void {
  pending.get(requestId)?.(dataUrl);
}

export function requestFrame(
  emit: (e: RendererEvent) => void,
  timeoutMs = 6000,
): Promise<string | null> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val: string | null): void => {
      if (settled) return;
      settled = true;
      pending.delete(requestId);
      clearTimeout(timer);
      clearInterval(retry);
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    pending.set(requestId, finish);
    // Re-emite o pedido a cada 1500ms — cobre o caso do CameraPanel ainda
    // não ter montado (ex: "abre a câmera e olha" no mesmo turno).
    emit({ type: 'request_camera_frame', requestId });
    const retry = setInterval(() => {
      if (!settled) emit({ type: 'request_camera_frame', requestId });
    }, 1500);
  });
}
