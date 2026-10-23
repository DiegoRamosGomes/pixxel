// Publica um arquivo (foto ou vídeo) no Instagram: sobe pro Cloudinary pra
// ter URL pública, publica e apaga do Cloudinary depois que o IG baixou.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { destroyAsset, isCloudinaryAvailable, uploadFile } from './cloudinary.js';
import { isInstagramAvailable, publishMedia } from './instagram.js';

export async function publishInstagramFile(
  bytes: Buffer,
  fileName: string,
  caption: string,
  shareToFeed: boolean,
): Promise<{ ok: boolean; reason?: string; permalink?: string }> {
  if (!isInstagramAvailable()) {
    return { ok: false, reason: 'INSTAGRAM_API_KEY não configurada' };
  }
  if (!isCloudinaryAvailable()) {
    return { ok: false, reason: 'Cloudinary não configurado (.env)' };
  }
  const dir = await mkdtemp(join(tmpdir(), 'pixxel-ig-'));
  // basename: o nome vem do cliente, não deixa escapar do diretório temporário.
  const tmpPath = join(dir, basename(fileName) || 'upload.bin');
  try {
    await writeFile(tmpPath, bytes);
    const upload = await uploadFile(tmpPath);
    if (!upload) return { ok: false, reason: 'falha no upload Cloudinary' };
    try {
      const isVideo = upload.resourceType === 'video';
      const result = await publishMedia(upload.url, caption, isVideo, {
        shareToFeed: isVideo ? shareToFeed : undefined,
      });
      if (!result.ok) return { ok: false, reason: result.reason };
      return { ok: true, permalink: result.permalink };
    } finally {
      // Limpa do Cloudinary depois que o IG já baixou.
      await destroyAsset(upload.publicId, upload.resourceType);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
