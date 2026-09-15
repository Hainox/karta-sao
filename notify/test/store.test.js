import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createStore } from '../src/store.js';

async function store() {
  const dir = await mkdtemp(path.join(tmpdir(), 'notify-store-'));
  const instance = createStore({ dir });
  await instance.init();
  return instance;
}

test('пишет и читает журнал в порядке добавления', async () => {
  const instance = await store();
  await instance.appendJournal({ type: 'event', event: { title: 'Первое' } });
  await instance.appendJournal({ type: 'event', event: { title: 'Второе' } });
  const journal = await instance.readJournal(10);
  assert.equal(journal.length, 2);
  assert.equal(journal[0].event.title, 'Первое');
  assert.equal(journal[1].event.title, 'Второе');
  assert.ok(journal[0].at);
});

test('журнал отдаёт только последние записи', async () => {
  const instance = await store();
  for (let index = 0; index < 5; index += 1) await instance.appendJournal({ type: 'event', index });
  const journal = await instance.readJournal(2);
  assert.deepEqual(journal.map((entry) => entry.index), [3, 4]);
});

test('ведёт открытые вопросы и закрывает их решением', async () => {
  const instance = await store();
  const pending = await instance.addPending({ kind: 'question', question: 'Продолжать?', options: [] });
  assert.equal((await instance.listPending()).length, 1);

  await instance.updatePending(pending.id, { delivered: [{ chatId: '1', messageId: 5 }] });
  await instance.closePending(pending.id, { status: 'answered', answer: 'yes' });

  assert.equal((await instance.listPending()).length, 0);
  const closed = await instance.getPending(pending.id);
  assert.equal(closed.status, 'answered');
  assert.equal(closed.resolution.answer, 'yes');
  assert.equal(closed.delivered[0].messageId, 5);
});

test('просроченные вопросы не попадают в список открытых', async () => {
  const instance = await store();
  await instance.addPending({ kind: 'question', question: 'Старый', options: [], expiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await instance.listPending()).length, 0);
});
