import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { parseMultipart } from '../src/multipart.js';

function requestFor(body, boundary) {
  const request = Readable.from([body]);
  request.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
  return request;
}

test('accepts a JPEG only when the declared and magic MIME match', async () => {
  const boundary = 'photo-test';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="performer"\r\n\r\nTester\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
    Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xd9]),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const parsed = await parseMultipart(requestFor(body, boundary));
  assert.equal(parsed.fields.performer, 'Tester');
  assert.equal(parsed.file.mimeType, 'image/jpeg');
});

test('rejects a spoofed image MIME', async () => {
  const boundary = 'photo-test';
  const body = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.jpg"\r\nContent-Type: image/jpeg\r\n\r\nnot-an-image\r\n--${boundary}--\r\n`);
  await assert.rejects(() => parseMultipart(requestFor(body, boundary)), /unsupported_image/);
});
