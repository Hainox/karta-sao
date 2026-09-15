import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';
import { createNotifier } from '../src/notifier.js';

function fakeTelegram() {
  const sent = [];
  let counter = 0;
  return {
    sent,
    async sendMessage(chatId, text, options) {
      counter += 1;
      sent.push({ chatId, text, options, messageId: counter });
      return { message_id: counter };
    },
    async editMessageText(chatId, messageId, text) {
      sent.push({ chatId, messageId, text, edited: true });
    }
  };
}

async function fixture(chatIds = ['111']) {
  const dir = await mkdtemp(path.join(tmpdir(), 'notify-notifier-'));
  const store = createStore({ dir });
  await store.init();
  const telegram = fakeTelegram();
  const config = { allowedChatIds: chatIds, answerTimeoutSeconds: 3600 };
  return { notifier: createNotifier({ config, telegram, store }), telegram, store };
}

test('публикует событие всем разрешённым чатам и пишет его в журнал', async () => {
  const { notifier, telegram, store } = await fixture(['111', '222']);
  const result = await notifier.publish({ kind: 'agent', title: 'Аудит завершён', text: 'Пять исправлений' });
  assert.equal(result.delivered.length, 2);
  assert.deepEqual(telegram.sent.map((item) => item.chatId), ['111', '222']);
  assert.match(telegram.sent[0].text, /Работа агента/);
  const journal = await store.readJournal(5);
  assert.equal(journal.filter((entry) => entry.type === 'event').length, 1);
});

test('задаёт вопрос с кнопками и хранит его открытым один раз', async () => {
  const { notifier, telegram, store } = await fixture();
  const result = await notifier.ask({ question: 'Обновлять зависимости?', options: [{ text: 'Да', value: 'yes' }, { text: 'Нет', value: 'no' }] });
  assert.equal(result.delivered.length, 1);
  assert.ok(telegram.sent[0].options.reply_markup.inline_keyboard.length === 2);
  const open = await store.listPending();
  assert.equal(open.length, 1);
  assert.equal(open[0].question, 'Обновлять зависимости?');
});

test('требует варианты ответа и текст вопроса', async () => {
  const { notifier } = await fixture();
  await assert.rejects(() => notifier.ask({ question: '', options: [{ text: 'Да', value: 'yes' }] }), /Вопрос не может быть пустым/);
  await assert.rejects(() => notifier.ask({ question: 'Текст', options: [] }), /хотя бы один вариант/);
});

test('запрашивает подтверждение действия', async () => {
  const { notifier, telegram, store } = await fixture();
  await notifier.requestAction({
    name: 'submission.approve',
    title: 'Утвердить набор правок района Аэропорт',
    payload: { submissionId: 'abc' },
    confirmText: 'Утвердить'
  });
  assert.match(telegram.sent[0].options.reply_markup.inline_keyboard[0][0].text, /Утвердить/);
  const [pending] = await store.listPending();
  assert.equal(pending.kind, 'action');
  assert.equal(pending.action.name, 'submission.approve');
  assert.equal(pending.action.payload.submissionId, 'abc');
});
