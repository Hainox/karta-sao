import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parsePointLabels, retirePlan } from '../scripts/retire-district-photo-points.js';

test('номера точек читаются из переписки: подписи, время, склеенные номера', () => {
  const { labels, problems } = parsePointLabels('Точка съёмки 12.362, Точка съёмки 2.640\nПользователь №1, 12:12\n9.215\n 9.216\n15.101515.1014\n9.215\n17.4');
  assert.deepEqual(labels.map((item) => item.label), ['12.362', '2.640', '9.215', '9.216', '15.1015', '15.1014']);
  assert.equal(labels[0].district, 'Савеловский');
  assert.equal(labels[2].district, 'Коптево');
  assert.equal(labels[4].district, 'Ховрино');
  assert.deepEqual(problems, ['17.4: нет района с номером 17']);
});

test('список на снятие от 2026-10-29 читается целиком', () => {
  const text = readFileSync(new URL('../scripts/retire-lists/2026-10-29-entrances.txt', import.meta.url), 'utf8');
  const { labels, problems } = parsePointLabels(text);
  assert.deepEqual(problems, []);
  const count = (district) => labels.filter((item) => item.district === district).length;
  assert.deepEqual([count('Савеловский'), count('Беговой'), count('Коптево'), count('Восточное Дегунино'), count('Сокол'), count('Ховрино')], [12, 12, 38, 4, 19, 51]);
});

test('план снимает только активные точки рабочего слоя своего района; архив и импорт остаются', async () => {
  const rows = [
    { id: 'a', label: '12.362', district: 'Савеловский', retired_at: null, live_photos: 0 },
    { id: 'b', label: '12.362', district: 'Сокол', retired_at: null, live_photos: 0 },
    { id: 'c', label: '9.215', district: 'Коптево', retired_at: null, live_photos: 1 },
    { id: 'd', label: '2.640', district: 'Беговой', retired_at: new Date(), live_photos: 0 },
    { id: 'e', label: '12.362', district: 'Савеловский', retired_at: null, hidden: true, live_photos: 0 },
    { id: 'f', label: '13.40', district: 'Сокол', retired_at: null, hidden: true, live_photos: 0 },
  ];
  const db = { query: async (sql, [dataset, labels]) => {
    assert.equal(dataset, 'sao_district_photo_points');
    return { rows: rows.filter((row) => labels.includes(row.label)) };
  } };
  const { labels } = parsePointLabels('12.362 9.215 2.640 5.489 13.40');
  const plan = await retirePlan(db, labels);
  assert.deepEqual(plan.retire.map((row) => row.id), ['a', 'c']);
  assert.deepEqual(plan.withPhotos.map((row) => row.label), ['9.215']);
  assert.deepEqual(plan.already, ['2.640']);
  assert.deepEqual(plan.missing, ['5.489', '13.40']);
  assert.deepEqual(plan.kept.map((row) => row.id), ['e', 'f'], 'архив и импорт с тем же номером не снимаются');
  assert.deepEqual(plan.doubled, []);
});
