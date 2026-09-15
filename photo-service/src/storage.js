import { createReadStream } from 'node:fs';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export function mediaRoot(environment = process.env) {
  return resolve(environment.PHOTO_SERVICE_MEDIA_ROOT || './media');
}

export async function writeMedia(buffer, mimeType, root = mediaRoot()) {
  const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/webp' ? 'webp' : 'jpg';
  const storageKey = `${randomUUID()}.${extension}`;
  const target = join(root, storageKey);
  const temp = `${target}.uploading`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(temp, buffer, { flag: 'wx', mode: 0o600 });
  await rename(temp, target);
  return { storageKey, sha256: createHash('sha256').update(buffer).digest('hex'), path: target };
}

export function readMedia(storageKey, root = mediaRoot()) {
  if (typeof storageKey !== 'string' || !/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(storageKey)) {
    throw new Error('invalid_storage_key');
  }
  return createReadStream(join(root, storageKey));
}

export async function removeMedia(storageKey, root = mediaRoot()) {
  if (typeof storageKey !== 'string' || !/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(storageKey)) {
    throw new Error('invalid_storage_key');
  }
  try {
    await unlink(join(root, storageKey));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
