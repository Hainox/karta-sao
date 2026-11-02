import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { buildDigitizationReport, summarizeDigitization } from '../src/digitization-report.js';

const points = [
  { district: 'Коптево', label: '9.10', kind: null, state: 'accepted', lastPhotoAt: '2026-10-27T08:00:00Z' },
  { district: 'Коптево', label: '9.2', kind: null, state: 'pending', lastPhotoAt: '2026-10-28T06:00:00Z' },
  { district: 'Коптево', label: '9.3', kind: null, state: 'rework', lastPhotoAt: '2026-10-26T06:00:00Z', rejectedComment: 'Не та сторона', rejectedAt: '2026-10-27T09:00:00Z' },
  { district: 'Аэропорт', label: '1.1', kind: null, state: 'empty', lastPhotoAt: null },
];

test('свод считает точки по районам в формате сводки парковок', () => {
  const summary = summarizeDigitization({ points, generatedAt: new Date('2026-10-28T07:00:00Z') });
  assert.equal(summary.districtRows.length, 16, 'все 16 районов, даже без точек');
  const koptevo = summary.districtRows.find((row) => row.label === 'Коптево');
  assert.deepEqual(
    [koptevo.objects, koptevo.closed, koptevo.empty, koptevo.review, koptevo.reworkObjects],
    [3, 1, 0, 1, 1],
  );
  assert.equal(koptevo.lastPhotoAt, '2026-10-28T06:00:00.000Z');
  assert.deepEqual([summary.total.objects, summary.total.closed, summary.total.empty], [4, 1, 1]);
  assert.deepEqual(summary.pointRows.filter((row) => row.district === 'Коптево').map((row) => row.label), ['9.2', '9.3', '9.10']);
});

test('разбивка по видам появляется, только когда виды заданы', () => {
  const kinds = { dp: 'Детские площадки', sp: 'Спортивные площадки' };
  const summary = summarizeDigitization({
    points: [{ district: 'Сокол', label: 'Адрес 1', kind: 'dp', state: 'accepted' }, { district: 'Сокол', label: 'Адрес 2', kind: 'sp', state: 'empty' }],
    kinds,
  });
  assert.deepEqual(summary.kindRows.map((row) => [row.label, row.objects, row.closed]), [['Детские площадки', 1, 1], ['Спортивные площадки', 1, 0]]);
  assert.equal(summarizeDigitization({ points }).kindRows.length, 0);
});

test('книга Excel: свод по районам, точки и лист доработки с причиной', async () => {
  const summary = summarizeDigitization({ points, generatedAt: new Date('2026-10-28T07:00:00Z') });
  const buffer = await buildDigitizationReport(summary, { title: 'Оцифровка въездных групп' });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ['Свод по районам', 'Точки', 'На доработке']);
  const overview = book.getWorksheet('Свод по районам');
  // Форма по эталону префектуры: тёмно-зелёная строка названия на всю ширину,
  // пять колонок, районы от лучшего процента принятых.
  assert.equal(overview.getCell('A1').value, 'Оцифровка въездных групп');
  assert.equal(overview.getCell('F1').master.address, 'A1');
  assert.equal(overview.getCell('A1').fill.fgColor.argb, 'FF123A32');
  assert.deepEqual(overview.getRow(2).values.slice(1), ['Район', 'Всего Объектов', 'Объектов без фото', 'Объектов закрыто', 'Обьектов на доработке ', '% принято']);
  const totalRow = overview.getRow(3 + 16);
  assert.equal(totalRow.getCell(1).value, 'Итого по САО');
  assert.equal(totalRow.getCell(2).value, 4);
  assert.equal(totalRow.getCell(6).numFmt, '0%');
  const shares = [];
  for (let row = 3; row < 3 + 16; row += 1) shares.push(overview.getRow(row).getCell(6).value);
  assert.deepEqual(shares, [...shares].sort((a, b) => b - a), 'районы от большего процента к меньшему');
  assert.equal(overview.views[0].ySplit, 2);
  const rework = book.getWorksheet('На доработке');
  assert.deepEqual(rework.getRow(1).values.slice(1), ['Район', 'Точка', 'Что исправить', 'Отклонено', 'На карте']);
  assert.equal(rework.getRow(2).getCell(3).value, 'Не та сторона');
  assert.match(JSON.stringify(rework.getRow(2).getCell(5).value), /districts\/koptevo\.html/);
  assert.deepEqual(book.getWorksheet('Точки').getRow(1).values.slice(1), ['Район', 'Точка', 'Статус', 'На карте']);
});

test('строки очереди точек съёмки превращаются в точки свода', async () => {
  const { slotPointsForReport } = await import('../src/tpu-points/district-point-photos.js');
  const points = slotPointsForReport([
    { district: 'Коптево', label: '9.1', photo_status: 'accepted', photo_id: 'a', uploaded_at: '2026-10-27T08:00:00Z' },
    { district: 'Коптево', label: '9.2', rejected_photo_id: 'r', rejected_comment: 'Темно', rejected_at: '2026-10-27T10:00:00Z', rejected_uploaded_at: '2026-10-27T07:00:00Z' },
    { district: 'Коптево', label: '9.3' },
  ]);
  assert.deepEqual(points.map((point) => point.state), ['accepted', 'rework', 'empty']);
  assert.equal(points[1].rejectedComment, 'Темно');
  assert.equal(points[1].lastPhotoAt, '2026-10-27T07:00:00Z');
});

