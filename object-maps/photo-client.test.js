import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('карта сохраняет заметную категорию доработки без кластеризации', async () => {
  const [client, css] = await Promise.all([
    readFile(new URL('./photo-client.js', import.meta.url), 'utf8'),
    readFile(new URL('./photo-client.css', import.meta.url), 'utf8'),
  ]);

  assert.match(client, /value="rework"/);
  assert.match(client, /statusKey === 'rework'/);
  assert.match(client, /НА ДОРАБОТКЕ/);
  assert.match(client, /ensurePointLayer\(!reworkOnly && filtered\.length > CLUSTER_FROM_MARKERS\)/);
  assert.match(client, /setFilter\(\(object\) => visible\.has\(Number\(object\.id\)\)\)/);
  assert.match(client, /countCoverageStatus\(filtered, state\.coverage, state\.entry\.objectType, 'rework'\)/);
  assert.match(css, /\.pa-row-rework/);
  assert.match(css, /\.pa-legend-rework/);
  assert.match(css, /#d7193f/);
  assert.match(css, /\.pa-map-status \{ display: none; \}/);
});

test('сводка отличает объекты от точек, а счётчик карты сверяется по рисуемым ID', async () => {
  const [client, model] = await Promise.all([
    readFile(new URL('./photo-client.js', import.meta.url), 'utf8'),
    readFile(new URL('./photo-model.js', import.meta.url), 'utf8'),
  ]);

  assert.match(model, /key: 'Объектов без фото'/);
  assert.match(model, /export function auditPointLayer\(/);
  assert.match(model, /export function isDrawablePoint\(/);
  assert.match(client, /Без фото на карте —/);
  assert.match(client, /ID из сводки отсутствуют в наборе карты/);
  assert.match(client, /\.filter\(isDrawablePoint\)/);
  assert.match(client, /if \(!isDrawablePoint\(record\)\) return \[\]/);
});

test('выбор района Сокол приближает карту к отфильтрованным подъездам', async () => {
  const client = await readFile(new URL('./photo-client.js', import.meta.url), 'utf8');

  assert.ok(/element\('paGroupFilter'\)\.addEventListener\('change',[\s\S]{0,320}fitMapToRecords\(currentRecords\(\)\)/.test(client), 'смена района должна приближать выбранные точки');
  assert.ok(/state\.map\.setBounds\(viewport\.bounds/.test(client), 'область карты должна вычисляться по координатам точек');
});

test('основной фильтр района приближает карту к точкам после обновления сводки', async () => {
  const client = await readFile(new URL('./photo-client.js', import.meta.url), 'utf8');

  assert.ok(/element\('paDistrictFilter'\)\.addEventListener\('change', async \(\) => \{[\s\S]{0,220}await refreshCoverage\(\);[\s\S]{0,160}fitMapToRecords\(currentRecords\(\)\)/.test(client), 'основной фильтр района должен подгонять карту под отфильтрованные точки после загрузки данных');
});
