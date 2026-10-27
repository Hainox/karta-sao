// Свод кабинета приёмки фотофиксации: точки съёмки, статусы объектов и Excel
// по образцу сводки оцифровки парковок.
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import test from 'node:test';
import { buildReviewReport, reviewPointStates, summarizeReview, summarizeReviewObject } from '../src/review-report.js';

const photo = (id, sourceId, reviewStatus, uploadedAt, extra = {}) => ({
  id, sourceId, reviewStatus, uploadedAt, reviewedAt: uploadedAt, reviewReason: '', ...extra,
});

const object = (overrides = {}) => ({
  object_key: 'stops|Аэропорт|1',
  object_type: 'stop',
  district: 'Аэропорт',
  label: 'Остановка Тестовая',
  source_ids: ['s1'],
  balance_holder: null,
  odh_id: null,
  photos: [],
  ...overrides,
});

test('точка закрывается последним кадром, отклонение перевешивает прошлую приёмку', () => {
  const closed = reviewPointStates(object({ photos: [photo('a', 's1', 'confirmed', '2026-10-01T09:00:00Z')] }));
  assert.equal(closed.points[0].status, 'closed');
  const rejected = reviewPointStates(object({ photos: [
    photo('a', 's1', 'confirmed', '2026-10-01T09:00:00Z'),
    photo('b', 's1', 'rejected', '2026-10-02T09:00:00Z'),
  ] }));
  assert.equal(rejected.points[0].status, 'rework');
  assert.equal(rejected.points[0].rejected.reviewReason, '');
  const pending = reviewPointStates(object({ photos: [photo('a', 's1', 'pending_review', '2026-10-02T09:00:00Z')] }));
  assert.equal(pending.points[0].status, 'review');
});

test('у ПП два кадра на точку; до старой нормы хватает одного', () => {
  const modern = summarizeReviewObject(object({
    object_type: 'pp', source_ids: ['p1'],
    photos: [photo('a', 'p1', 'confirmed', '2026-10-01T09:00:00Z')],
  }));
  assert.deepEqual([modern.required, modern.accepted, modern.status], [1, 0, 'progress']);
  const done = summarizeReviewObject(object({
    object_type: 'pp', source_ids: ['p1'],
    photos: [
      photo('a', 'p1', 'confirmed', '2026-10-01T09:00:00Z'),
      photo('b', 'p1', 'confirmed', '2026-10-01T09:05:00Z'),
    ],
  }));
  assert.deepEqual([done.accepted, done.status], [1, 'closed']);
  const legacy = summarizeReviewObject(object({
    object_type: 'pp', source_ids: ['p1'],
    photos: [photo('a', 'p1', 'confirmed', '2026-09-01T09:00:00Z')],
  }));
  assert.deepEqual([legacy.accepted, legacy.status], [1, 'closed']);
});

test('сводка считает объекты по состояниям, ставит АвД последней и делит по видам', () => {
  const rows = [
    object({ object_key: 'stop:1', label: 'Остановка 1', photos: [photo('a', 's1', 'confirmed', '2026-10-01T09:00:00Z')] }),
    object({ object_key: 'stop:2', label: 'Остановка 2', photos: [photo('b', 's1', 'pending_review', '2026-10-02T09:00:00Z')] }),
    object({ object_key: 'pp:1', object_type: 'pp', label: 'Переход', source_ids: ['p1'], photos: [photo('c', 'p1', 'rejected', '2026-10-03T09:00:00Z', { reviewReason: 'Не видно разметку' })] }),
    object({ object_key: 'entrance:1', object_type: 'entrance', label: 'Подъезд', district: 'АвД САО', photos: [] }),
    object({ object_key: 'entrance:2', object_type: 'entrance', label: 'Подъезд 2', district: 'Сокол', photos: [] }),
  ];
  const summary = summarizeReview({ rows, generatedAt: new Date('2026-10-27T12:00:00Z') });
  assert.deepEqual(summary.groupRows.map((row) => row.label), ['Аэропорт', 'Сокол', 'АвД САО']);
  assert.deepEqual(summary.typeRows.map((row) => row.label), ['Остановки', 'ПП', 'Подъезды (входные группы)']);
  assert.deepEqual(
    summary.typeRows.map((row) => [row.objects, row.closed, row.empty, row.review, row.reworkObjects]),
    [[2, 1, 0, 1, 0], [1, 0, 0, 0, 1], [2, 0, 2, 0, 0]],
  );
  assert.deepEqual([summary.total.objects, summary.total.required, summary.total.accepted, summary.total.rework], [5, 5, 1, 1]);
  assert.equal(summary.total.filled, 2, 'отклонённая точка не считается загруженной');
  assert.equal(summary.total.lastPhotoAt, '2026-10-03T09:00:00.000Z');
  const onlyEntrances = summarizeReview({ rows, type: 'entrance' });
  assert.deepEqual(onlyEntrances.typeRows.map((row) => row.label), ['Подъезды (входные группы)']);
  assert.equal(onlyEntrances.total.objects, 2);
});

test('точки без sourceId: один кадр — одно задание, отклонённый кадр возвращает весь объект', () => {
  const unbound = summarizeReviewObject(object({
    source_ids: [],
    photos: [photo('a', null, 'confirmed', '2026-10-01T09:00:00Z')],
  }));
  assert.deepEqual([unbound.required, unbound.accepted, unbound.status], [1, 1, 'closed']);
  const mixed = summarizeReviewObject(object({
    source_ids: ['s1'],
    photos: [
      photo('a', 's1', 'confirmed', '2026-10-01T09:00:00Z'),
      photo('b', null, 'rejected', '2026-10-02T09:00:00Z', { reviewReason: 'Не тот ракурс' }),
    ],
  }));
  assert.deepEqual([mixed.accepted, mixed.rework, mixed.status], [1, 1, 'rework']);
  assert.equal(mixed.filled, 1, 'кадр без точки на доработке не считается загруженной точкой');
});

test('книга Excel: листы и оформление по образцу сводки парковок', async () => {
  const rows = [
    object({ object_key: 'stop:1', label: 'Остановка 1', odh_id: '123', photos: [photo('a', 's1', 'confirmed', '2026-10-01T09:00:00Z')] }),
    object({ object_key: 'entrance:1', object_type: 'entrance', label: 'Подъезд', photos: [photo('b', 's1', 'rejected', '2026-10-02T09:00:00Z', { reviewReason: 'Не видно номер' })] }),
  ];
  const summary = summarizeReview({ rows, generatedAt: new Date('2026-10-27T12:00:00Z') });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await buildReviewReport(summary));

  assert.deepEqual(book.worksheets.map((sheet) => sheet.name), ['Свод по районам', 'Объекты', 'На доработке']);
  const overview = book.getWorksheet('Свод по районам');
  assert.match(overview.getRow(1).getCell(1).value, /^Свод по фото остановок, ПП и подъездов \(входных групп\) на /);
  assert.equal(overview.getRow(1).getCell(1).fill.fgColor.argb, 'FFFFFF00');
  assert.equal(overview.getRow(4).getCell(2).value, 'Всего Объектов');
  assert.equal(overview.getRow(4).getCell(5).value, 'Обьектов на проверке');
  assert.equal(overview.getRow(4).getCell(3).fill.fgColor.argb, 'FF123A32');
  assert.equal(overview.views[0].ySplit, 4);
  assert.equal(overview.getRow(overview.rowCount - 3).getCell(1).value, 'Вид объекта');
  assert.equal(overview.getRow(overview.rowCount - 2).getCell(1).value, 'Остановки');
  assert.equal(overview.getRow(overview.rowCount - 1).getCell(1).value, 'ПП');
  assert.equal(overview.getRow(overview.rowCount).getCell(1).value, 'Подъезды (входные группы)');

  const objects = book.getWorksheet('Объекты');
  const row = objects.getRow(2);
  assert.equal(row.getCell(1).value, 'Остановки');
  assert.equal(row.getCell(3).value, '123');
  assert.equal(row.getCell(10).value, 'Закрыт');
  assert.equal(row.getCell(10).fill.fgColor.argb, 'FFD8F0DE');
  assert.match(row.getCell(12).hyperlink, /object-maps\/stops\.html\?dataset=stops$/);
  const reworkRow = objects.getRow(3);
  assert.equal(reworkRow.getCell(10).value, 'На доработке');

  const rework = book.getWorksheet('На доработке');
  assert.deepEqual(rework.getRow(1).values.slice(1), ['Ответственный', 'Объект', 'Точка', 'Что исправить', 'Отклонено', 'На карте']);
  assert.deepEqual(rework.getRow(2).values.slice(1, 5), ['Аэропорт', 'Подъезд', 1, 'Не видно номер']);
  assert.match(rework.getRow(2).getCell(6).hyperlink, /entrances\.html\?dataset=entrances$/);
});

test('пустой лист «На доработке» объясняет, что возвратов нет', async () => {
  const summary = summarizeReview({ rows: [object({ photos: [] })] });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await buildReviewReport(summary));
  assert.equal(book.getWorksheet('На доработке').getRow(2).getCell(1).value, 'Точек на доработке нет.');
  assert.equal(book.getWorksheet('Объекты').getRow(2).getCell(10).value, 'Нет фото');
});
