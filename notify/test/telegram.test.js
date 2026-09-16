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
