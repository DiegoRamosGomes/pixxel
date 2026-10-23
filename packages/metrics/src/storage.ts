// Status de armazenamento via `df` em formato POSIX (-P, blocos de 1 KB).
// Linux usa -T pra trazer o tipo do filesystem e filtrar os virtuais; o df do
// macOS não tem -T, então o filtro de "disco real" é por origem/montagem.

import { run } from './exec.js';

export type DiskInfo = {
  source: string;
  mount: string;
  fstype: string;
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
  usedPercent: number;
};

export type StorageResult = { text: string; disks: DiskInfo[] };

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

function toDisk(
  source: string,
  fstype: string,
  total: string,
  used: string,
  avail: string,
  mount: string,
): DiskInfo | null {
  const totalBytes = parseInt(total, 10) * 1024;
  const usedBytes = parseInt(used, 10) * 1024;
  const availBytes = parseInt(avail, 10) * 1024;
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

export function parseDfLinux(txt: string): DiskInfo[] {
  const out: DiskInfo[] = [];
  for (const line of txt.split('\n').slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/);
    if (!m) continue;
    const d = toDisk(m[1], m[2], m[3], m[4], m[5], m[6]);
    if (d) out.push(d);
  }
  return out;
}

export function parseDfDarwin(txt: string): DiskInfo[] {
  const out: DiskInfo[] = [];
  for (const line of txt.split('\n').slice(1)) {
    const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/);
    if (!m) continue;
    const d = toDisk(m[1], '', m[2], m[3], m[4], m[5]);
    if (d) out.push(d);
  }
  return out;
}

function isRealDarwinDisk(d: DiskInfo): boolean {
  if (!d.source.startsWith('/dev/')) return false;
  return d.mount === '/' || d.mount === '/System/Volumes/Data' || d.mount.startsWith('/Volumes/');
}

/**
 * No macOS o "/" é o volume de sistema selado (só leitura, quase vazio); os
 * dados do usuário vivem em /System/Volumes/Data. "Como está o disco" quer
 * esse segundo.
 */
export function resolveMount(mount: string, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'darwin' && mount === '/') return '/System/Volumes/Data';
  return mount;
}

async function readDf(path: string): Promise<DiskInfo[]> {
  const target = path === 'all' ? [] : [path];
  if (process.platform === 'darwin') {
    const disks = parseDfDarwin(await run('df', ['-kP', ...target]));
    return path === 'all' ? disks.filter(isRealDarwinDisk) : disks;
  }
  const disks = parseDfLinux(await run('df', ['-kPT', ...target]));
  return path === 'all' ? disks.filter((d) => !FAKE_FS.has(d.fstype)) : disks;
}

function formatGB(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 100) return `${Math.round(gb)} GB`;
  return `${gb.toFixed(1)} GB`;
}

export async function getStorageStatus(mount: string = '/'): Promise<StorageResult> {
  let disks: DiskInfo[] = [];
  try {
    disks = await readDf(resolveMount(mount));
  } catch (err) {
    console.warn('[storage] df falhou:', err);
  }
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
      `${d.mount}${d.fstype ? ` (${d.fstype})` : ''}: ${formatGB(d.usedBytes)}/${formatGB(d.totalBytes)} ` +
      `— ${formatGB(d.availBytes)} livres (${d.usedPercent}%)`,
  );
  return { text: lines.join('\n'), disks };
}
