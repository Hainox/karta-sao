import test from 'node:test';
import assert from 'node:assert/strict';
import { rankReviewReasons, reasonKey } from '../src/review-reasons.js';

test('reasonKey ignores case, ё, spaces and the final dot', () => {
  assert.equal(reasonKey('  Фото  размытое. '), reasonKey('фото размытое'));
  assert.equal(reasonKey('Объект не попал в кадр'), reasonKey('объект не попал в кадр.'));
  assert.equal(reasonKey('Снято далеко от объёкта'), 'снято далеко от объекта');
});

test('rankReviewReasons puts repeated real reasons first, then defaults', () => {
  const rows = [
    { reason: 'Нет общего плана', n: 3 },
    { reason: 'нет общего плана.', n: 2 },
    { reason: 'Фото не по стрелке', n: 4 },
    { reason: 'Одиночный особый случай', n: 1 },
    { reason: 'ок', n: 9 },
  ];
  const list = rankReviewReasons(rows, { limit: 4, defaults: ['Фото размытое', 'Фото не по стрелке', 'Темно'] });
  assert.deepEqual(list, [
    { text: 'Нет общего плана', count: 5 },
    { text: 'Фото не по стрелке', count: 4 },
    { text: 'Фото размытое', count: 0 },
    { text: 'Темно', count: 0 },
  ]);
});

test('rankReviewReasons gives the default list when there are no returns yet', () => {
  const list = rankReviewReasons([], { limit: 3 });
  assert.equal(list.length, 3);
  assert.ok(list.every((r) => r.count === 0 && r.text.length > 5));
});
