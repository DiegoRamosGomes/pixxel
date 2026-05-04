// Status de armazenamento via `df`. Reporta a partição raiz por padrão;
// se mount=all, lista todos os filesystems "reais" (ignora tmpfs/devtmpfs/etc).

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export type DiskInfo = {
  source: string;
  mount: string;
  fstype: string;
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  usedPercent: number;
};

const FAKE_FS = new Set([
  'tmpfs',
  'devtmpfs',
  'squashfs',
  'overlay',
  'proc',
  'sysfs',
  'cgroup',
  'cgroup2',
  'fuse.gvfsd-fuse',
  'fuse.portal',
]);

function parseDfLine(line: string): DiskInfo | null {
  // Colunas: source target fstype size used avail
  const parts = line.trim().split(/\s+/);
  if (parts.length < 6) return null;
  const [source, mount, fstype, sizeStr, usedStr, availStr] = parts;
  const totalBytes = parseInt(sizeStr, 10);
  const usedBytes = parseInt(usedStr, 10);
  const availBytes = parseInt(availStr, 10);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return null;
  return {
    source,
    mount,
    fstype,
    totalBytes,
    usedBytes,
    availBytes,
    usedPercent: Math.round((usedBytes / totalBytes) * 1000) / 10,
  };
}

async function readDf(path: string): Promise<DiskInfo[]> {
  const cmd =
    path === 'all'
      ? 'df -B1 --output=source,target,fstype,size,used,avail'
      : `df -B1 --output=source,target,fstype,size,used,avail ${JSON.stringify(path)}`;
  const { stdout } = await execAsync(cmd);
  const lines = stdout.split('\n').slice(1);
  const disks: DiskInfo[] = [];
  for (const line of lines) {
    const d = parseDfLine(line);
    if (!d) continue;
    if (path === 'all' && FAKE_FS.has(d.fstype)) continue;
    disks.push(d);
  }
  return disks;
}

function formatGB(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  return `${gb.toFixed(1)} GB`;
}

export type StorageResult = {
  text: string;
  disks: DiskInfo[];
};

export async function getStorageStatus(
  mount: string = '/',
): Promise<StorageResult> {
  const disks = await readDf(mount);
  if (disks.length === 0) {
    return { text: 'Não consegui ler o armazenamento.', disks: [] };
  }
  if (mount !== 'all') {
    const d = disks[0];
    const text =
      `Disco ${d.mount}: ${formatGB(d.usedBytes)} usados de ` +
      `${formatGB(d.totalBytes)} (${d.usedPercent}%), ` +
      `${formatGB(d.availBytes)} livres.`;
    return { text, disks };
  }
  const lines = disks.map(
    (d) =>
      `${d.mount} (${d.fstype}): ${formatGB(d.usedBytes)}/${formatGB(d.totalBytes)} ` +
      `— ${formatGB(d.availBytes)} livres (${d.usedPercent}%)`,
  );
  return { text: lines.join('\n'), disks };
}
