import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPhotoLinks } from './check-photo-links.mjs';

const original = [{
  id: 'P', district: 'Сокол', coordinates: [37.51, 55.81],
  slots: [{ id: 'P-1', azimuth: 25, status: 'empty', photoId: null },
    { id: 'P-2', azimuth: 118, status: 'rework', photoId: 'prior-photo' }],
}];
const proposed = [{ ...original[0], slots: [original[0].slots[1]] }];

test('сохраняет точный кадр, обнаруживает потерю связи с возвращённым кадром', () => {
  assert.deepEqual(checkPhotoLinks(original, proposed).issues, []);
  const empty = [{ ...proposed[0], slots: [original[0].slots[0]] }];
  assert.deepEqual(checkPhotoLinks(original, empty).issues.map(i => i.reason), ['occupied-frame-removed']);
});
test('запрещает дать прежний ID новому ракурсу или другому балансу', () => {
  for (const change of [{ coordinates: [37.52, 55.81] }, { district: 'Коптево' },
    { balance: 'Коптево' }, { id: 'another' }, { slots: [{ id: 'P-2', azimuth: 119 }] }]) {
    assert.deepEqual(checkPhotoLinks(original, [{ ...proposed[0], ...change }]).issues.map(i => i.reason),
      ['frame-repurposed']);
  }
});
test('проверяет единственность точки, слота и направления', () => {
  assert.throws(() => checkPhotoLinks(original, original));
  assert.throws(() => checkPhotoLinks(original, [...proposed, ...proposed]));
  assert.throws(() => checkPhotoLinks(original, [{ ...proposed[0], slots: [{ id: 'P-2', azimuth: 360 }] }]));
});
