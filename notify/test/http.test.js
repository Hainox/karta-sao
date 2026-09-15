import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createNotifier } from '../src/notifier.js';
import { createHttpServer } from '../src/http.js';

async function fixture({ secret = 'top-secret' } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'notify-http-'));
  const store = createStore({ dir });
  await store.init();
  const sent = [];
  const telegram = {
    async sendMessage(chatId, text, options) {
      sent.push({ chatId, text, options });
      return { message_id: sent.length };
    }
  };
  const config = { allowedChatIds: ['111'], answerTimeoutSeconds: 3600, secret, journalLimit: 50 };
  const notifier = createNotifier({ config, telegram, store });
  const server = createHttpServer({ config, notifier, store });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, store, sent, server };
}

async function post(base, path_, body, secret) {
  const response = await fetch(`${base}${path_}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Notify-Secret': secret } : {}) },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

test('здоровье сервиса доступно без секрета', async (t) => {
  const { base, server } = await fixture();
  t.after(() => server.close());
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, open: 0 });
});

test('без секрета событие не принимается', async (t) => {
  const { base, server } = await fixture();
  t.after(() => server.close());
  const result = await post(base, '/event', { title: 'Проверка' });
  assert.equal(result.status, 401);
});

test('с секретом событие уходит в чат и в журнал', async (t) => {
  const { base, store, sent, server } = await fixture();
  t.after(() => server.close());
  const result = await post(base, '/event', { kind: 'client', title: 'Район отправил набор', service: 'odh-api' }, 'top-secret');
  assert.equal(result.status, 202);
  assert.equal(result.body.delivered, 1);
  assert.match(sent[0].text, /Работа пользователя/);
  assert.equal((await store.readJournal(5)).filter((entry) => entry.type === 'event').length, 1);
});

test('событие без текста отклоняется', async (t) => {
  const { base, server } = await fixture();
  t.after(() => server.close());
  const result = await post(base, '/event', {}, 'top-secret');
  assert.equal(result.status, 400);
});

test('вопрос создаётся и его можно прочитать по номеру', async (t) => {
  const { base, server } = await fixture();
  t.after(() => server.close());
  const created = await post(base, '/ask', { question: 'Обновить зависимости?', options: [{ text: 'Да', value: 'yes' }] }, 'top-secret');
  assert.equal(created.status, 202);
  const response = await fetch(`${base}/pending/${created.body.id}`, { headers: { 'X-Notify-Secret': 'top-secret' } });
  const body = await response.json();
  assert.equal(body.pending.status, 'open');
  assert.equal(body.pending.question, 'Обновить зависимости?');
});

test('запрос подтверждения действия создаётся с кнопками', async (t) => {
  const { base, sent, server } = await fixture();
  t.after(() => server.close());
  const created = await post(base, '/action', { name: 'submission.approve', title: 'Утвердить набор', payload: { submissionId: 'uuid-1' } }, 'top-secret');
  assert.equal(created.status, 202);
  const keyboard = sent[0].options.reply_markup.inline_keyboard[0];
  assert.match(keyboard[0].callback_data, /^a:/);
});

test('некорректный секрет не пропускается', async (t) => {
  const { base, server } = await fixture();
  t.after(() => server.close());
  const result = await post(base, '/event', { title: 'Проверка' }, 'wrong-secret');
  assert.equal(result.status, 401);
});

test('битый JSON не роняет сервер', async (t) => {
  const { base, server } = await fixture();
  t.after(() => server.close());
  const response = await fetch(`${base}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Notify-Secret': 'top-secret' },
    body: '{не json'
  });
  assert.equal(response.status, 400);
});
