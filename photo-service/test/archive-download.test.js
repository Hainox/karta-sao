import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, writeFile, rm, stat, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
const begin = source.indexOf('async function serveArchiveFile(');
const end = source.indexOf('\nfunction originAllowed(', begin);
assert.ok(begin >= 0 && end > begin);
const dir = await mkdtemp(join(tmpdir(), 'archive-http-'));
const name = 'sao-district-odh-2026-11-10-1234abcd.zip';
await writeFile(join(dir, name), '0123456789');
const serve = vm.runInNewContext(source.slice(begin, end) + '\nserveArchiveFile', {
  ARCHIVE_FILE_PATTERN: /^sao-.*\.zip$/, archiveDir: () => dir, process,
  join, stat, createReadStream, corsHeaders: () => ({}),
  sendError: (res, req, status) => { res.writeHead(status); res.end(); }
});
const server = createServer((req, res) => {
  serve(req, res, name).catch(error => res.destroy(error));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:' + server.address().port;
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test('archive advertises stable validators for browser resumption', async () => {
  const res = await fetch(url);
  await res.arrayBuffer();
  assert.match(res.headers.get('etag') || '', /^"[^"]+"$/);
  assert.ok(Number.isFinite(Date.parse(res.headers.get('last-modified'))));
});
test('matching If-Range continues without duplicating earlier bytes', async () => {
  const first = await fetch(url); await first.arrayBuffer();
  const etag = first.headers.get('etag');
  const res = await fetch(url, { headers: { Range: 'bytes=4-', 'If-Range': etag || '"missing"' } });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), '456789');
});
test('changed validator returns whole file instead of corrupting resumed archive', async () => {
  const res = await fetch(url, { headers: { Range: 'bytes=4-', 'If-Range': '"stale"' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '0123456789');
});
test('suffix range returns final bytes of ZIP central directory', async () => {
  const res = await fetch(url, { headers: { Range: 'bytes=-3' } });
  assert.equal(res.status, 206);
  assert.equal(await res.text(), '789');
  assert.equal(res.headers.get('content-range'), 'bytes 7-9/10');
});
test('unsatisfiable range is rejected with archive size', async () => {
  const res = await fetch(url, { headers: { Range: 'bytes=10-' } });
  assert.equal(res.status, 416);
  assert.equal(res.headers.get('content-range'), 'bytes */10');
});
test('HEAD exposes size and validator without streaming the archive', async () => {
  const res = await fetch(url, { method: 'HEAD' });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-length'), '10');
  assert.ok(res.headers.get('etag'));
  assert.equal((await res.arrayBuffer()).byteLength, 0);
});
test('resumes past four GiB using the original 64-bit offset', async () => {
  const large = 'sao-district-odh-2026-11-10-ffffffff.zip';
  const handle = await open(join(dir, large), 'w');
  const offset = 2 ** 32 + 16;
  await handle.write(Buffer.from('tail'), 0, 4, offset);
  await handle.close();
  const sparseServer = createServer((req, res) => { serve(req, res, large).catch(error => res.destroy(error)); });
  await new Promise(resolve => sparseServer.listen(0, '127.0.0.1', resolve));
  try {
    const res = await fetch('http://127.0.0.1:' + sparseServer.address().port, { headers: { Range: 'bytes=' + offset + '-' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-range'), 'bytes ' + offset + '-' + (offset + 3) + '/' + (offset + 4));
    assert.equal(await res.text(), 'tail');
  } finally { await new Promise(resolve => sparseServer.close(resolve)); }
});
