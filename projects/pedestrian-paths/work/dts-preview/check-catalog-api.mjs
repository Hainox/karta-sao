import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createYardPathLayerRouter } from '../../../../photo-service/src/tpu-points/yard-path-layer.js';

const express = createRequire(new URL('../../../../photo-service/package.json', import.meta.url))('express');
const catalogPath = process.argv[2];
assert.ok(catalogPath, 'Укажите каталог рабочей копии');
const { points } = JSON.parse(await readFile(catalogPath, 'utf8'));
const editsDir = await mkdtemp(join(tmpdir(), 'dts-local-'));
const editsPath = join(editsDir, 'edits.json');
const app = express();
app.use(express.json());
// Моделируем только метаданные одного принятого снимка. Файлы не требуются.
const neighborId = points.find(p => p.district === points[0].district && p.id !== points[0].id).slots[0].id;
const demoPhoto = { frame_id: neighborId, id: '00000000-0000-4000-8000-000000000001', status: 'accepted' };
const router = () => createYardPathLayerRouter({ catalogPath, editsPath,
  authenticate(req, _res, next) { req.user = { role: 'prefecture_admin' }; next(); },
  pool: { async query() { return { rows: [demoPhoto] }; } },
});
let current = router();
app.use((req, res, next) => current(req, res, next));
const server = app.listen(0, '127.0.0.1');
try {
  await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const readDistrict = async name => {
    const response = await fetch(base + '/?district=' + encodeURIComponent(name));
    assert.equal(response.status, 200);
    return (await response.json()).points;
  };
  const districtNames = new Set(points.map(p => p.district));
  for (const name of districtNames) {
    const expected = points.filter(p => p.district === name);
    const actual = await readDistrict(name);
    assert.deepEqual(actual.map(p => p.id), expected.map(p => p.id));
    for (const [i, p] of actual.entries()) {
      assert.equal(p.slots.length, 1);
      assert.equal(p.slots[0].id, expected[i].slots[0].id);
      assert.equal(p.slots[0].azimuth, expected[i].slots[0].azimuth);
      assert.equal(p.slots[0].photoId, p.slots[0].id === demoPhoto.frame_id ? demoPhoto.id : null);
      assert.deepEqual(p.coordinates, expected[i].coordinates);
    }
  }
  const [sample, neighbor] = await readDistrict(points[0].district);
  assert.ok(neighbor);
  const patch = body => fetch(base + '/' + encodeURIComponent(sample.id), {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const angle = (sample.slots[0].azimuth + 17) % 360;
  assert.equal((await patch({ slotId: neighbor.slots[0].id, azimuth: angle })).status, 404);
  assert.equal((await patch({ slotId: sample.slots[0].id, azimuth: angle })).status, 200);
  current = router();
  const reloaded = await readDistrict(sample.district);
  const savedSlot = reloaded.find(p => p.id === sample.id).slots[0];
  assert.equal(savedSlot.azimuth, angle);
  assert.equal(savedSlot.photoId, null);
  assert.equal(neighbor.slots[0].photoId, demoPhoto.id);
  assert.equal(neighbor.slots[0].status, 'accepted');
  assert.deepEqual(reloaded.find(p => p.id === neighbor.id), neighbor);
  console.log(JSON.stringify({ points: points.length, districts: districtNames.size, independentEditSurvivedRestart: true }));
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(editsDir, { force: true, recursive: true });
}
