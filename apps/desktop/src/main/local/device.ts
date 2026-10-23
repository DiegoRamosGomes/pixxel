// "Como está este dispositivo": métricas da máquina onde o Electron roda.

import { formatSnapshotForVoice, getStorageStatus, getSystemSnapshot } from '@assistant/metrics';
import type { LocalToolResult } from '@assistant/shared';

export async function deviceStatus(): Promise<LocalToolResult> {
  const snapshot = await getSystemSnapshot();
  return { ok: true, text: formatSnapshotForVoice(snapshot, 'este dispositivo'), meta: { snapshot } };
}

export async function deviceStorage(mount: string): Promise<LocalToolResult> {
  const r = await getStorageStatus(mount);
  return { ok: true, text: r.text, meta: { disks: r.disks } };
}
