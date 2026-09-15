import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createBot } from '../src/bot.js';
import { createNotifier } from '../src/notifier.js';

function fakeTelegram() {
  const sent = [];
  const edited = [];
  const answered = [];
  let counter = 0;
  return {
    sent,
    edited,
    answered,
    async sendMessage(chatId, text, options) {
      counter += 1;
      sent.push({ chatId, text, options });
      return { message_id: counter };
    },
    async editMessageText(chatId, messageId, text) {
      edited.push({ chatId, messageId, text });
    },
    async answerCallbackQuery(id, text) {
      answered.push({ id, text });
    },
    async setMyCommands() {}
  };
}

async function fixture({ chatIds = ['111'], actions } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'notify-bot-'));
  const store = createStore({ dir });
  await store.init();
  const telegram = fakeTelegram();
  const config = { allowedChatIds: chatIds, answerTimeoutSeconds: 3600, pollTimeoutSeconds: 0 };
  const notifier = createNotifier({ config, telegram, store });
  const executed = [];
  const actionRegistry = actions || {
    has: (name) => name === 'submission.approve',
    async run(name, payload) {
      executed.push({ name, payload });
      return 'Набор утверждён · Аэропорт';
    }
  };
  const logger = { warn() {}, error() {}, log() {} };
  return { bot: createBot({ config, telegram, store, notifier, actions: actionRegistry, logger }), telegram, store, executed };
}

function callbackUpdate(data, chatId = '111') {
  return { update_id: 1, callback_query: { id: 'cb-1', data, message: { message_id: 42, chat: { id: Number(chatId) } } } };
}

test('ответ на вопрос кнопкой закрывает его и попадает в журнал', async () => {
  const { bot, telegram, store } = await fixture();
  const pending = await store.addPending({ kind: 'question', question: 'Продолжать?', options: [{ text: 'Да', value: 'yes' }, { text: 'Нет', value: 'no' }] });

  await bot.handleUpdate(callbackUpdate(`q:${pending.id}:1`));

  const closed = await store.getPending(pending.id);
  assert.equal(closed.status, 'answered');
  assert.equal(closed.resolution.answer, 'no');
  assert.match(telegram.edited.at(-1).text, /Ответ: <b>no<\/b>/);
  const journal = await store.readJournal(5);
  assert.equal(journal.find((entry) => entry.type === 'answer').answer, 'no');
});

test('подтверждение действия запускает действие и показывает результат', async () => {
  const { bot, telegram, store, executed } = await fixture();
  const pending = await store.addPending({
    kind: 'action',
    action: { name: 'submission.approve', payload: { submissionId: 'uuid-1' } },
    title: 'Утвердить набор правок района Аэропорт'
  });

  await bot.handleUpdate(callbackUpdate(`a:${pending.id}:go`));

  assert.deepEqual(executed, [{ name: 'submission.approve', payload: { submissionId: 'uuid-1' } }]);
  assert.match(telegram.edited.at(-1).text, /Выполнено/);
  assert.match(telegram.edited.at(-1).text, /Набор утверждён/);
  const closed = await store.getPending(pending.id);
  assert.equal(closed.status, 'done');
});

test('отмена действия ничего не выполняет', async () => {
  const { bot, store, executed } = await fixture();
  const pending = await store.addPending({ kind: 'action', action: { name: 'submission.approve', payload: {} }, title: 'Утвердить набор' });

  await bot.handleUpdate(callbackUpdate(`a:${pending.id}:cancel`));

  assert.equal(executed.length, 0);
  assert.equal((await store.getPending(pending.id)).status, 'cancelled');
});

test('падение действия честно показывается и записывается', async () => {
  const { bot, telegram, store } = await fixture({
    actions: { has: () => true, async run() { throw new Error('API ответил 403'); } }
  });
  const pending = await store.addPending({ kind: 'action', action: { name: 'submission.approve', payload: {} }, title: 'Утвердить набор' });

  await bot.handleUpdate(callbackUpdate(`a:${pending.id}:go`));

  assert.match(telegram.edited.at(-1).text, /Не удалось выполнить/);
  assert.match(telegram.edited.at(-1).text, /API ответил 403/);
  const closed = await store.getPending(pending.id);
  assert.equal(closed.status, 'failed');
  assert.equal(closed.resolution.error, 'API ответил 403');
});

test('повторное нажатие по закрытому вопросу не выполняется дважды', async () => {
  const { bot, telegram, store, executed } = await fixture();
  const pending = await store.addPending({ kind: 'action', action: { name: 'submission.approve', payload: {} }, title: 'Утвердить набор' });
  await bot.handleUpdate(callbackUpdate(`a:${pending.id}:go`));
  await bot.handleUpdate(callbackUpdate(`a:${pending.id}:go`));
  assert.equal(executed.length, 1);
  assert.match(telegram.answered.at(-1).text, /уже закрыт/i);
});

test('сообщение из чужого чата игнорируется', async () => {
  const { bot, telegram, store } = await fixture();
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 999 }, text: 'привет' } });
  assert.equal(telegram.sent.length, 0);
  assert.equal((await store.readJournal(5)).length, 0);
});

test('текстовый ответ закрывает единственный открытый вопрос', async () => {
  const { bot, store } = await fixture();
  const pending = await store.addPending({ kind: 'question', question: 'Какой район?', options: [{ text: 'Да', value: 'yes' }] });
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 111 }, text: 'Аэропорт' } });
  const closed = await store.getPending(pending.id);
  assert.equal(closed.status, 'answered');
  assert.equal(closed.resolution.answer, 'Аэропорт');
  assert.equal(closed.resolution.via, 'text');
});

test('команда /status отвечает про открытые запросы', async () => {
  const { bot, telegram, store } = await fixture();
  await store.addPending({ kind: 'question', question: 'Ждём ответа', options: [{ text: 'Да', value: 'yes' }] });
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 111 }, text: '/status' } });
  assert.match(telegram.sent.at(-1).text, /Открытых вопросов и подтверждений: 1/);
});

test('сообщение записывается в журнал, когда открытых вопросов нет', async () => {
  const { bot, store } = await fixture();
  await bot.handleUpdate({ update_id: 1, message: { chat: { id: 111 }, text: 'Проверь карту ОДХ' } });
  const journal = await store.readJournal(5);
  assert.equal(journal[0].type, 'message');
  assert.equal(journal[0].text, 'Проверь карту ОДХ');
});
