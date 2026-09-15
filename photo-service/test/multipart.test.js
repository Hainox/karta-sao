import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { MAX_THUMBNAIL_BYTES, parseMultipart } from '../src/multipart.js';

function requestFor(body, boundary) {
  const request = Readable.from([body]);
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return request;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xd9]);

function part(boundary, name, filename, mimeType, payload, last = false) {
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"${filename ? `; filename="${filename}"` : ''}\r\n${mimeType ? `Content-Type: ${mimeType}\r\n` : ''}\r\n`;
  return Buffer.concat([Buffer.from(header), payload, Buffer.from(last ? '\r\n' : '\r\n')]);
}

test('accepts a JPEG only when the declared and magic MIME match', async () => {
  const boundary = 'photo-test';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="performer"\r\n\r\nTester\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    JPEG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const parsed = await parseMultipart(requestFor(body, boundary));
  assert.equal(parsed.fields.performer, 'Tester');
  assert.equal(parsed.file.mimeType, 'image/jpeg');
  assert.equal(parsed.thumbnail, null);
});

test('rejects a spoofed image MIME', async () => {
  const boundary = 'photo-test';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\nnot-an-image\r\n--${boundary}--\r\n`);
  await assert.rejects(() => parseMultipart(requestFor(body, boundary)), /unsupported_image/);
});

test('accepts an optional preview next to the original photo', async () => {
  const boundary = 'photo-test';
  const body = Buffer.concat([
    part(boundary, 'file', 'photo.jpg', 'image/jpeg', JPEG),
    part(boundary, 'thumbnail', 'preview.jpg', 'image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0x11, 0x22, 0xd9])),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const parsed = await parseMultipart(requestFor(body, boundary));
  assert.equal(parsed.file.buffer.length, JPEG.length);
  assert.equal(parsed.thumbnail.mimeType, 'image/jpeg');
  assert.equal(parsed.thumbnail.buffer.length, 6);
});

test('rejects a preview that is not the declared image type', async () => {
  const boundary = 'photo-test';
  const body = Buffer.concat([
    part(boundary, 'file', 'photo.jpg', 'image/jpeg', JPEG),
    part(boundary, 'thumbnail', 'preview.jpg', 'image/jpeg', Buffer.from('not-an-image')),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  await assert.rejects(() => parseMultipart(requestFor(body, boundary)), /unsupported_thumbnail/);
});

test('rejects a preview larger than the preview limit', async () => {
  const boundary = 'photo-test';
  const oversized = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(MAX_THUMBNAIL_BYTES + 16, 0x20), Buffer.from([0xd9])]);
  const body = Buffer.concat([
    part(boundary, 'file', 'photo.jpg', 'image/jpeg', JPEG),
    part(boundary, 'thumbnail', 'preview.jpg', 'image/jpeg', oversized),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  await assert.rejects(() => parseMultipart(requestFor(body, boundary)), /thumbnail_too_large/);
});

test('ignores an unknown extra file part instead of storing it', async () => {
  const boundary = 'photo-test';
  const body = Buffer.concat([
    part(boundary, 'file', 'photo.jpg', 'image/jpeg', JPEG),
    part(boundary, 'attachment', 'other.jpg', 'image/jpeg', JPEG),
    Buffer.from(`--${boundary}--\r\n`),
  ]);
  const parsed = await parseMultipart(requestFor(body, boundary));
  assert.equal(parsed.file.mimeType, 'image/jpeg');
  assert.equal(parsed.thumbnail, null);
});
