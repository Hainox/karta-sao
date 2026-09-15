import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, keyboardFor, parseCallback, renderEvent } from '../src/events.js';

test('экранирует HTML в тексте уведомления', () => {
  assert.equal(escapeHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
});

test('собирает сообщение события с полями и источником', () => {
  const text = renderEvent({
    kind: 'error',
    level: 'critical',
    service: 'photo-service',
    title: 'Публикация фото упала',
    text: 'Диск переполнен',
    fields: { Район: 'Аэропорт', Файлов: 3 }
  });
  assert.match(text, /🔥 <b>Ошибка<\/b> · 🚨 критично/);
  assert.match(text, /<b>Публикация фото упала<\/b>/);
  assert.match(text, /• Район: Аэропорт/);
  assert.match(text, /• Файлов: 3/);
  assert.match(text, /Источник: photo-service/);
});

test('не подставляет пустые поля', () => {
  const text = renderEvent({ kind: 'agent', title: 'Готово', fields: { Пусто: '', Есть: 'да' } });
  assert.doesNotMatch(text, /Пусто/);
  assert.match(text, /• Есть: да/);
});

test('строит кнопки вопроса по вариантам ответа', () => {
  const keyboard = keyboardFor({
    id: 'abc',
    kind: 'question',
    options: [{ text: 'Да', value: 'yes' }, { text: 'Нет', value: 'no' }]
  });
  assert.deepEqual(keyboard.inline_keyboard, [
    [{ text: 'Да', callback_data: 'q:abc:0' }],
    [{ text: 'Нет', callback_data: 'q:abc:1' }]
  ]);
});

test('строит кнопки подтверждения действия', () => {
  const keyboard = keyboardFor({ id: 'xyz', kind: 'action', confirmText: 'Утвердить' });
  assert.deepEqual(keyboard.inline_keyboard, [[
    { text: 'Утвердить', callback_data: 'a:xyz:go' },
    { text: 'Отменить', callback_data: 'a:xyz:cancel' }
  ]]);
});

test('разбирает callback-данные', () => {
  assert.deepEqual(parseCallback('q:abc:1'), { kind: 'question', id: 'abc', index: 1 });
  assert.deepEqual(parseCallback('a:xyz:go'), { kind: 'action', id: 'xyz', decision: 'go' });
  assert.equal(parseCallback('мусор'), null);
  assert.equal(parseCallback('q::0'), null);
});
