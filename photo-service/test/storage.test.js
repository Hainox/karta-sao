import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { mediaRoot, readMedia, removeMedia, writeMedia } from '../src/storage.js';

test('writes media under a generated key and rejects traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sao-photo-test-'));
  try {
    const stored = await writeMedia(Buffer.from([1, 2, 3]), 'image/jpeg', root);
    assert.match(stored.storageKey, /^[0-9a-f-]{36}\.jpg$/);
    assert.equal((await readFile(join(root, stored.storageKey))).length, 3);
    assert.throws(() => readMedia('../secret.jpg', root), /invalid_storage_key/);
    await removeMedia(stored.storageKey, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('uses an explicit media root instead of the old service settings', () => {
  assert.match(mediaRoot({ PHOTO_SERVICE_MEDIA_ROOT: 'C:/photo-media' }), /photo-media$/);
});
