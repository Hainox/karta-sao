import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

function frames(points, singleSlot) {
  const index = new Map();
  const ids = new Set();
  for (const p of points) {
    assert.ok(typeof p.id === 'string' && p.id && !ids.has(p.id), 'Повтор или пропуск ID точки');
    ids.add(p.id);
    assert.ok(Array.isArray(p.coordinates) && p.coordinates.length === 2 && p.coordinates.every(Number.isFinite));
    assert.ok(Array.isArray(p.slots) && p.slots.length > 0 && (!singleSlot || p.slots.length === 1), p.id);
    for (const slot of p.slots) {
      assert.ok(typeof slot.id === 'string' && slot.id && !index.has(slot.id), 'Повтор или пропуск ID слота');
      assert.ok(Number.isFinite(slot.azimuth) && slot.azimuth >= 0 && slot.azimuth < 360, slot.id);
      index.set(slot.id, { point: p, slot });
    }
  }
  return index;
}

export function checkPhotoLinks(original, proposed) {
  const oldFrames = frames(original, false);
  const newFrames = frames(proposed, true);
  const issues = [];
  let occupied = 0;
  let retained = 0;
  for (const [frameId, { point, slot }] of oldFrames) {
    assert.ok(['pending', 'accepted', 'empty', 'rework'].includes(slot.status), frameId);
    assert.ok(slot.status === 'empty' ? slot.photoId === null
      : typeof slot.photoId === 'string' && slot.photoId.length > 0, frameId);
    const hasPhoto = slot.status !== 'empty';
    if (hasPhoto) occupied++;
    const current = newFrames.get(frameId);
    if (!current) {
      if (hasPhoto) issues.push({ frameId, reason: 'occupied-frame-removed' });
      continue;
    }
    const { point: target } = current;
    if (point.id !== target.id || point.district !== target.district || point.balance !== target.balance
      || point.coordinates.some((v, i) => v !== target.coordinates[i]) || slot.azimuth !== current.slot.azimuth) {
      issues.push({ frameId, reason: 'frame-repurposed' });
    } else {
      retained++;
    }
  }
  return { originalFrames: oldFrames.size, proposedFrames: newFrames.size, occupied, retained, issues };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const paths = process.argv.slice(2);
  assert.equal(paths.length, 2, 'Передайте снимок API и новый каталог');
  const [original, proposed] = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const result = checkPhotoLinks(original.points, proposed.points);
  console.log(JSON.stringify(result, null, 2));
  if (result.issues.length) process.exitCode = 1;
}
