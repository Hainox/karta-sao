import assert from 'node:assert/strict';
import test from 'node:test';
import { createNotifyClient } from '../lib/notify.js';

test('клиент отправляет выгрузку в /document с base64 и секретом', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 202, json: async () => ({ delivered: 1 }) };
  };
  const client = createNotifyClient({ url: 'http://notify.local/', secret: 's3cret', fetchImpl });
  const result = await client.document({ file: 'BASE64', filename: 'routes.geojson', caption: 'Отчёт по маршрутам ОДХ' });
  assert.deepEqual(result, { delivered: 1 });
  assert.equal(calls[0].url, 'http://notify.local/document');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].options.headers['X-Notify-Secret'], 's3cret');
  assert.deepEqual(JSON.parse(calls[0].options.body), { file: 'BASE64', filename: 'routes.geojson', caption: 'Отчёт по маршрутам ОДХ' });
});

test('без адреса сервиса выгрузка не отправляется', async () => {
  const client = createNotifyClient({ url: '', secret: 's', fetchImpl: async () => { throw new Error('не должно вызываться'); } });
  assert.equal(client.enabled, false);
  assert.equal(await client.document({ file: 'x' }), null);
});

test('сбой отправки выгрузки пишется в лог и не пробрасывается', async () => {
  const logged = [];
  const client = createNotifyClient({
    url: 'http://notify.local',
    fetchImpl: async () => ({ ok: false, status: 500 }),
    logger: { warn: (message) => logged.push(message) }
  });
  assert.equal(await client.document({ file: 'x', filename: 'routes.csv' }), null);
  assert.match(logged[0], /HTTP 500/);
});
