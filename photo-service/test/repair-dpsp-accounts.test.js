import assert from 'node:assert/strict';
import test from 'node:test';
import { accountChanges, parseAccounts } from '../scripts/repair-dpsp-accounts.js';

test('файл учёток: логин, район и пароль читаются построчно', () => {
  const { entries, problems } = parseAccounts([
    '# Логин\tРайон\tПароль',
    'dpsp.koptevo\tКоптево\ttest-password-1234',
    ' dpsp.sokol \t Сокол \ttest-password-5678',
    'dpsp.hovrino; Ховрино ;test-password-9012',
    '',
  ].join('\r\n'));
  assert.deepEqual(problems, []);
  assert.deepEqual(entries.map(entry => [entry.login, entry.district]),
    [['dpsp.koptevo', 'Коптево'], ['dpsp.sokol', 'Сокол'], ['dpsp.hovrino', 'Ховрино']]);
  assert.equal(entries[0].display_name, 'ДП/СП · Коптево');
  assert.equal(entries[0].password, 'test-password-1234');
});

test('файл учёток: ошибки перечисляются до записи', () => {
  const { entries, problems } = parseAccounts([
    'dpsp.koptevo\tКоптево\tкороткий',
    'dpsp.unknown\tТверь\ttest-password-1234',
    'dpsp.sokol\tСокол\ttest-password-1234',
    'dpsp.sokol\tСокол\ttest-password-1234',
    'без табуляции',
  ].join('\n'));
  assert.equal(entries.length, 2);
  assert.equal(problems.length, 4);
  assert.ok(problems.some(problem => problem.includes('короче 12')));
  assert.ok(problems.some(problem => problem.includes('не район САО')));
  assert.ok(problems.some(problem => problem.includes('повторяется')));
  assert.ok(problems.some(problem => problem.includes('через табуляцию')));
  assert.equal(problems.filter(problem => problem.includes('через табуляцию')).length, 1);
});

test('что меняется у действующей и отсутствующей учётки', () => {
  const entry = { district: 'Коптево', password: 'x' };
  assert.deepEqual(accountChanges(null, entry, false), ['создать']);
  assert.deepEqual(accountChanges({ role: 'dpsp_district_editor', district: 'Коптево', active: true }, entry, true), []);
  assert.deepEqual(accountChanges({ role: 'district_editor', district: 'Сокол', active: false }, entry, false),
    ['роль district_editor → dpsp_district_editor', 'район Сокол → Коптево', 'включить', 'сбросить пароль']);
});
