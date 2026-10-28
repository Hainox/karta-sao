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
  const buffer = await buildDigitizationReport(summary, { title: 'Свод по фото въездных групп', note: 'Пояснение' });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ['Свод по районам', 'Точки', 'На доработке']);
  const overview = book.getWorksheet('Свод по районам');
  assert.match(String(overview.getCell('A1').value), /^Свод по фото въездных групп на 28\.10\.2026/);
  assert.deepEqual(overview.getRow(4).values.slice(1, 4), ['Район', 'Всего Объектов', 'Объектов закрыто']);
  const totalRow = overview.getRow(5 + 16);
  assert.equal(totalRow.getCell(1).value, 'Итого по САО');
  assert.equal(totalRow.getCell(2).value, 4);
  const rework = book.getWorksheet('На доработке');
  assert.deepEqual(rework.getRow(1).values.slice(1), ['Район', 'Точка', 'Что исправить', 'Отклонено', 'На карте']);
  assert.equal(rework.getRow(2).getCell(3).value, 'Не та сторона');
  assert.match(JSON.stringify(rework.getRow(2).getCell(5).value), /districts\/koptevo\.html/);
  assert.deepEqual(book.getWorksheet('Точки').getRow(1).values.slice(1), ['Район', 'Точка', 'Статус', 'Последнее фото', 'На карте']);
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
