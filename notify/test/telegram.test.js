import assert from 'node:assert/strict';
import test from 'node:test';
import { createTelegram } from '../src/telegram.js';

// Повторы не должны тормозить тесты.
const sleep = async () => {};

test('повторяет отправку, когда связь с Telegram обрывается', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) throw new TypeError('fetch failed');
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) };
  };
  const telegram = createTelegram({ token: 'token', fetchImpl, sleep });
  const result = await telegram.sendMessage('chat', 'Добрый день');
  assert.equal(result.message_id, 7);
  assert.equal(attempts, 3);
});

test('не повторяет отказ самой службы', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return { ok: false, status: 400, json: async () => ({ ok: false, description: 'chat not found' }) };
  };
  const telegram = createTelegram({ token: 'token', fetchImpl, sleep });
  await assert.rejects(() => telegram.sendMessage('chat', 'Добрый день'), /chat not found/);
  assert.equal(attempts, 1);
});

test('фотографию тоже отправляет с повторами', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 9 } }) };
  };
  const telegram = createTelegram({ token: 'token', fetchImpl, sleep });
  const result = await telegram.sendPhoto('chat', { buffer: Buffer.from('png'), caption: 'Сводка' });
  assert.equal(result.message_id, 9);
  assert.equal(attempts, 2);
});

test('документ уходит multipart-запросом с адресом, подписью и файлом', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 11 } }) };
  };
  const telegram = createTelegram({ token: 'token', fetchImpl, sleep });
  const buffer = Buffer.from('район;маршрут', 'utf8');
  const result = await telegram.sendDocument('chat', { buffer, filename: 'routes.csv', caption: 'Отчёт по маршрутам ОДХ' });
  assert.equal(result.message_id, 11);
  assert.match(captured.url, /\/bottoken\/sendDocument$/);
  assert.equal(captured.options.method, 'POST');
  const form = captured.options.body;
  assert.equal(form.get('chat_id'), 'chat');
  assert.equal(form.get('caption'), 'Отчёт по маршрутам ОДХ');
  assert.equal(form.get('parse_mode'), 'HTML');
  const file = form.get('document');
  assert.equal(file.name, 'routes.csv');
  assert.equal(file.type, 'text/csv');
});

test('для незнакомого расширения берёт общий MIME-тип и режет подпись до 1024', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, options };
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 12 } }) };
  };
  const telegram = createTelegram({ token: 'token', fetchImpl, sleep });
  const longCaption = 'я'.repeat(2000);
  await telegram.sendDocument('chat', { buffer: Buffer.from('x'), filename: 'routes.odd', caption: longCaption });
  const form = captured.options.body;
  assert.equal(form.get('caption').length, 1024);
  assert.equal(form.get('document').type, 'application/octet-stream');
});

test('документ повторяет отправку, когда связь обрывается', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('fetch failed');
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 13 } }) };
  };
  const telegram = createTelegram({ token: 'token', fetchImpl, sleep });
  const result = await telegram.sendDocument('chat', { buffer: Buffer.from('x'), filename: 'routes.csv' });
  assert.equal(result.message_id, 13);
  assert.equal(attempts, 2);
});

test('не повторяет отказ самой службы на документе', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return { ok: false, status: 400, json: async () => ({ ok: false, description: 'file is too big' }) };
  };
  const telegram = createTelegram({ token: 'token', fetchImpl, sleep });
  await assert.rejects(
    () => telegram.sendDocument('chat', { buffer: Buffer.from('x'), filename: 'routes.csv' }),
    /Telegram sendDocument: file is too big/
  );
  assert.equal(attempts, 1);
});
