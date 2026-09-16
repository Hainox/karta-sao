import assert from 'node:assert/strict';
import test from 'node:test';
import { headquartersBoard } from '../src/headquarters.js';
import { renderHeadquartersImage } from '../src/digest.js';

function row(objectType, district, points, covered, holder = null) {
  return { objectType, district, balanceHolder: holder, sourcePointCount: points, coveredPoints: covered };
}

const payload = {
  objects: [
    row('stop', 'Аэропорт', 10, 4),
    row('pp', 'Аэропорт', 5, 0),
    row('entrance', 'Аэропорт', 20, 20),
    row('stop', 'Сокол', 7, 0),
    row('stop', 'Сокол', 100, 60, 'АвД САО'),
    // Переходы ДЭУ штаб ведёт на АвД: район их снимает, объём работ — владельцу.
    row('pp', 'Аэропорт', 300, 300, 'ДЭУ 1'),
    row('pp', null, 3, 0),
  ],
};

test('модель листа: «АвД САО» с ДЭУ и объектами без района, порядок по «Итого %»', () => {
  const board = headquartersBoard(payload);

  // Районы по алфавиту, «АвД САО» — последней строкой.
  assert.deepEqual(board.names, ['Аэропорт', 'Сокол', 'АвД САО']);
  // Во второй таблице — по убыванию процента «Итого»: у АвД 360 из 403 — 89 %,
  // у Аэропорта 24 из 35 — 69 %, у Сокола ни одной закрытой отметки.
  assert.deepEqual(board.sorted.map((item) => item.name), ['АвД САО', 'Аэропорт', 'Сокол']);

  // АвД: своя остановка, переход ДЭУ и переход без района; Соколу его остановка не считается.
  const autodor = board.counts[2];
  assert.equal(autodor.plan.stop, 100);
  assert.equal(autodor.plan.pp, 303);
  assert.equal(board.counts[1].plan.stop, 7);
  assert.deepEqual(board.lagging, ['Сокол']);

  // Всего 384 отметки из 445 — 86 %.
  assert.equal(board.total.plan.stop, 117);
  assert.equal(board.total.plan.pp, 308);
  assert.equal(board.percent, Math.round((384 / 445) * 100));
});

test('картинка сводки: PNG с таблицей и подписью-комментарием', () => {
  const board = headquartersBoard(payload);
  const { png, caption } = renderHeadquartersImage(board, { generatedAt: new Date('2026-09-16T18:00:00Z') });

  assert.equal(png.subarray(0, 8).toString('latin1'), '\u0089PNG\r\n\u001a\n');
  assert.ok(png.length > 10000, `картинка слишком маленькая: ${png.length} байт`);
  assert.equal(png.readUInt32BE(16), 1386);

  assert.match(caption, /^Направление — «Оцифровка объектов САО» — /);
  assert.match(caption, /Коллеги, добрый день!/);
  assert.match(caption, /Оцифровка объектов САО: 384 из 445 отметок — 86 %\./);
  assert.match(caption, /Слабая динамика по оцифровке объектов!/);
  assert.match(caption, /Сокол/);
  assert.match(caption, /Больше всего закрыто: АвД САО — 89 %/);
  assert.match(caption, /Слабее всего — /);
});
