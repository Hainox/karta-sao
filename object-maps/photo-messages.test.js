import assert from 'node:assert/strict';
import test from 'node:test';
import { errorText } from './photo-messages.js';

// Коды, которые фотослужба отдаёт клиенту. Ни один не должен попасть на экран
// как есть: район видел «Вход не выполнен: invalid_credentials».
const CODES = [
  'invalid_credentials', 'too_many_login_attempts', 'authentication_required', 'prefecture_role_required',
  'object_out_of_scope', 'object_not_found', 'photo_not_found', 'reference_photo_cannot_be_deleted',
  'photo_already_confirmed', 'photo_not_pending',
  'dataset_required', 'source_point_required', 'performer_required', 'gps_required', 'invalid_gps',
  'gps_accuracy_unusable', 'file_required', 'file_too_large', 'unsupported_image', 'invalid_multipart',
  'idempotency_key_required', 'archive_not_found', 'archive_job_not_found',
];

test('каждый код сервиса переводится в понятный текст', () => {
  for (const code of CODES) {
    const text = errorText(code, code);
    assert.ok(text, `${code}: текст не должен быть пустым`);
    assert.notEqual(text, code, `${code}: код не должен показываться пользователю`);
    assert.match(text, /[а-яА-Я]/, `${code}: текст должен быть на русском`);
  }
});

test('сообщение сервиса важнее словаря', () => {
  assert.equal(errorText('performer_required', 'Укажите исполнителя съёмки.'), 'Укажите исполнителя съёмки.');
});

test('пустое сообщение сервиса не затирает словарь', () => {
  assert.equal(errorText('performer_required', '   '), 'Укажите исполнителя.');
  assert.equal(errorText('performer_required', null), 'Укажите исполнителя.');
});

test('неизвестный код без сообщения даёт общий текст, а не пустоту', () => {
  assert.equal(errorText('something_new', ''), 'Не удалось выполнить действие — повторите попытку.');
  assert.equal(errorText('', undefined), 'Не удалось выполнить действие — повторите попытку.');
});

test('неизвестный код с сообщением показывается сообщением сервиса', () => {
  assert.equal(errorText('something_new', 'Сервис занят, повторите позже.'), 'Сервис занят, повторите позже.');
});
