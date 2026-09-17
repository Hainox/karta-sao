import assert from 'node:assert/strict';
import test from 'node:test';
import { firstMissingUploadField, UPLOAD_FIELD_MESSAGES } from '../src/upload-fields.js';

test('каждая пустая причина отправки называется своим кодом', () => {
  assert.deepEqual(firstMissingUploadField({ datasetId: '', sourceId: 'pp:1:2', performer: 'Иванов' }),
    { code: 'dataset_required', message: UPLOAD_FIELD_MESSAGES.dataset_required });
  assert.deepEqual(firstMissingUploadField({ datasetId: 'sao_stops', sourceId: '', performer: 'Иванов' }),
    { code: 'source_point_required', message: UPLOAD_FIELD_MESSAGES.source_point_required });
  assert.deepEqual(firstMissingUploadField({ datasetId: 'sao_stops', sourceId: 'stop:1', performer: '  ' }),
    { code: 'performer_required', message: UPLOAD_FIELD_MESSAGES.performer_required });
});

test('заполненные поля не дают ошибки, пробелы вокруг значения не мешают', () => {
  assert.equal(firstMissingUploadField({ datasetId: 'sao_stops', sourceId: 'stop:1', performer: 'Иванов И.' }), null);
  assert.equal(firstMissingUploadField({ datasetId: ' sao_stops ', sourceId: ' stop:1 ', performer: ' Иванов И. ' }), null);
});

test('порядок проверки: сначала набор, потом точка, потом исполнитель', () => {
  assert.equal(firstMissingUploadField({}).code, 'dataset_required');
  assert.equal(firstMissingUploadField({ datasetId: 'sao_stops' }).code, 'source_point_required');
});

test('пустой ввод вместо объекта не роняет проверку', () => {
  assert.equal(firstMissingUploadField().code, 'dataset_required');
});

test('тексты ошибок на русском и не повторяют код', () => {
  for (const [code, message] of Object.entries(UPLOAD_FIELD_MESSAGES)) {
    assert.match(message, /[а-яА-Я]/, `${code}: нужен русский текст`);
    assert.notEqual(message, code);
  }
});
