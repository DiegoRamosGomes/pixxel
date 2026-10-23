// Upload temporário no Cloudinary pra servir como URL pública pro Instagram.
// Fluxo: upload(filePath) → URL pública → publica no IG → destroy(publicId).
// Usa signed upload (api_key + api_secret).

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';

const CLOUD = () => process.env.CLOUDINARY_CLOUD_NAME ?? '';
const KEY = () => process.env.CLOUDINARY_API_KEY ?? '';
const SECRET = () => process.env.CLOUDINARY_API_SECRET ?? '';

export const isCloudinaryAvailable = (): boolean =>
  Boolean(CLOUD() && KEY() && SECRET());

function sign(params: Record<string, string | number>, secret: string): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return createHash('sha1').update(sorted + secret).digest('hex');
}

export type CloudinaryUpload = {
  url: string;
  publicId: string;
  resourceType: 'image' | 'video';
};

export async function uploadFile(filePath: string): Promise<CloudinaryUpload | null> {
  if (!isCloudinaryAvailable()) return null;
  const cloud = CLOUD();
  const key = KEY();
  const secret = SECRET();

  const ext = filePath.toLowerCase().split('.').pop() ?? '';
  const isVideo = ['mp4', 'mov', 'webm'].includes(ext);
  const resourceType: 'image' | 'video' = isVideo ? 'video' : 'image';

  const buf = await readFile(filePath);
  const timestamp = Math.floor(Date.now() / 1000);
  const folder = 'pixxel-instagram';
  const signature = sign({ folder, timestamp }, secret);

  const form = new FormData();
  const blob = new Blob([new Uint8Array(buf)]);
  form.append('file', blob, basename(filePath));
  form.append('api_key', key);
  form.append('timestamp', String(timestamp));
  form.append('folder', folder);
  form.append('signature', signature);

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${cloud}/${resourceType}/upload`,
      { method: 'POST', body: form },
    );
    if (!res.ok) {
      const body = await res.text();
      console.warn(`[cloudinary] upload error ${res.status}:`, body.slice(0, 300));
      return null;
    }
    const data = (await res.json()) as { secure_url: string; public_id: string };
    return { url: data.secure_url, publicId: data.public_id, resourceType };
  } catch (err) {
    console.warn('[cloudinary] upload failed:', err);
    return null;
  }
}

export async function destroyAsset(
  publicId: string,
  resourceType: 'image' | 'video' = 'image',
): Promise<void> {
  if (!isCloudinaryAvailable()) return;
  const cloud = CLOUD();
  const key = KEY();
  const secret = SECRET();
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = sign({ public_id: publicId, timestamp }, secret);

  try {
    const form = new FormData();
    form.append('public_id', publicId);
    form.append('api_key', key);
    form.append('timestamp', String(timestamp));
    form.append('signature', signature);
    await fetch(
      `https://api.cloudinary.com/v1_1/${cloud}/${resourceType}/destroy`,
      { method: 'POST', body: form },
    );
  } catch (err) {
    console.warn('[cloudinary] destroy failed:', err);
  }
}
