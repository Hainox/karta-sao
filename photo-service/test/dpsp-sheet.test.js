import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../../dev/templates/dpsp-sheet.gs', import.meta.url), 'utf8');

test('таблица направляет фото площадок и МАФ в свои обработчики превью', () => {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const tables = new Map();
  context.SpreadsheetApp = { getActive: () => ({ getSheetByName: (name) => name }) };
  context.writeTable = (sheet, rows) => { tables.set(sheet, rows); return rows.length; };
  const token = 'a'.repeat(32);
  context.writeSites([{ photo_token: token }, {}]);
  context.writeMaf([{ photo_token: token }, {}]);
  assert.equal(tables.get('Площадки')[0][12],
    `https://obhod-sao.ru/photo-api/object-photo-points/playgrounds/photo-thumb/${token}.jpg`);
  assert.equal(tables.get('МАФ')[0][10],
    `https://obhod-sao.ru/photo-api/object-photo-points/dpsp/photo-thumb/${token}.jpg`);
  assert.equal(tables.get('Площадки')[1][12], '');
  assert.equal(tables.get('МАФ')[1][10], '');
});

test('пересборка сверки показывает фото целиком и сохраняет решение', () => {
  const context = vm.createContext({});
  vm.runInContext(source, context);
  const writes = [];
  const sizes = [];
  const sheet = {
    getRange: (...args) => ({
      getValue: () => args[0] === 'B1' ? 'Все районы' : 'Все',
      setValues: (values) => writes.push({ args, values }),
      setFormulas: () => {},
      clearContent: () => {},
    }),
    getMaxRows: () => 20,
    setRowHeights: (...args) => sizes.push(['rows', ...args]),
    setColumnWidth: (...args) => sizes.push(['column', ...args]),
  };
  context.currentDecisions = () => ({ site1: { decision: 'Сверено', who: 'Проверяющий', when: '16.11.2026' } });
  context.writeTable = () => {};
  context.Session = { getActiveUser: () => ({ getEmail: () => '' }) };
  context.rebuildCross({ sites: [{ site_id: 'site1', photo_url: 'https://example.com/photo.jpg' }] }, sheet);
  const photoRow = writes.find((write) => write.args[1] === 9).values[0];
  assert.match(photoRow[0], /;1\)$/);
  assert.equal(photoRow[1], 'Сверено');
  assert.equal(photoRow[4], 'Проверяющий');
  assert.equal(photoRow[5], '16.11.2026');
  assert.ok(sizes.some((size) => size.join(',') === 'rows,7,1,160'));
  assert.ok(sizes.some((size) => size.join(',') === 'column,9,220'));
});
