import assert from 'node:assert/strict';
import test from 'node:test';
import { photoWithdrawVerdict, WITHDRAW_MESSAGES } from '../src/withdraw.js';

const photo = (reviewStatus) => ({ id: 'p-1', object_key: 'odh_pp_coordinates|pp|1|Коптево', review_status: reviewStatus });

test('район отзывает своё фото, пока оно на проверке', () => {
  const verdict = photoWithdrawVerdict(photo('pending_review'));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.already, false);
});

test('подтверждённое приёмкой фото отозвать нельзя', () => {
  const verdict = photoWithdrawVerdict(photo('confirmed'));
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 409);
  assert.equal(verdict.code, 'photo_already_confirmed');
  assert.equal(verdict.message, WITHDRAW_MESSAGES.photo_already_confirmed);
});

test('отклонённое фото отзывать нечего', () => {
  const verdict = photoWithdrawVerdict(photo('rejected'));
  assert.equal(verdict.status, 409);
  assert.equal(verdict.code, 'photo_not_pending');
});

test('повторный отзыв безобиден и не меняет ничего', () => {
  const verdict = photoWithdrawVerdict(photo('withdrawn'));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.already, true);
});

test('чужое фото и чужой район не отзываются', () => {
  const verdict = photoWithdrawVerdict(photo('pending_review'), { canWithdraw: false });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.status, 403);
  assert.equal(verdict.code, 'object_out_of_scope');
});

test('отсутствующее фото даёт 404, а не отказ по правам', () => {
  const verdict = photoWithdrawVerdict(null, { canWithdraw: true });
  assert.equal(verdict.status, 404);
  assert.equal(verdict.code, 'photo_not_found');
});

test('тексты отказов на русском и не повторяют код', () => {
  for (const [code, message] of Object.entries(WITHDRAW_MESSAGES)) {
    assert.match(message, /[а-яА-Я]/, `${code}: нужен русский текст`);
    assert.notEqual(message, code);
  }
});

test('отозванные кадры исключены из всех выборок, а ручка отзыва зарегистрирована', async () => {
  const { readFile } = await import('node:fs/promises');
  const reports = await readFile(new URL('../src/reports.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');

  // Отозванное фото должно вести себя как отклонённое: не попадать в галерею,
  // счётчики и выгрузки, иначе район «уберёт» кадр, а он останется в отчёте.
  assert.match(reports, /review_status NOT IN \('rejected', 'withdrawn'\)/);
  assert.equal((server.match(/review_status NOT IN \('rejected', 'withdrawn'\)/g) || []).length, 2);
  assert.match(server, /photos\\\/\(\[0-9a-f-\]\{36\}\)\\\/withdraw/);
});
