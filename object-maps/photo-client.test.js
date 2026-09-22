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
