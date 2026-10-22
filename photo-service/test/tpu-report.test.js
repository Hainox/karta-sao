// Сводка по ТПУ: числа считаются по текущему ракурсу точки, файл отдаётся только префектуре
// и не смешивается с отчётами ПП/ООТ/подъездов.
import assert from 'node:assert/strict';
import express from 'express';
import ExcelJS from 'exceljs';
import test from 'node:test';
import { createObjectPhotoPointsRouter } from '../src/tpu-points/object-photo-points.js';
import { TPU_OBJECTS, objectStatus, summarizeTpu, buildTpuReport } from '../src/tpu-points/tpu-report.js';

const objects = [
  { id: 'tpu:1', kind: 'tpu', label: 'ТПУ один', sourceNumber: '1', group: 'Аэропорт', district: 'Аэропорт', holder: 'Жилищник Аэропорт' },
  { id: 'parking:2', kind: 'parking', label: 'Парковка два', sourceNumber: '2', group: 'АвД САО', district: 'Сокол', holder: 'АвД САО' },
  { id: 'tpu:3', kind: 'tpu', label: 'ТПУ три', sourceNumber: '3', group: 'Аэропорт', district: 'Аэропорт', holder: 'Жилищник Аэропорт' },
];
const point = (key, district, photos, last = null) => ({ id: key + photos + district, object_key: key, district, label: '1', note: '', latitude: 55.8, longitude: 37.5, heading: 90, photo_count: photos, last_photo_at: last, created_at: '2026-10-01T10:00:00Z' });

test('статус объекта: нет точек, не начато, в работе, готово', () => {
  assert.equal(objectStatus([]), 'Нет точек');
  assert.equal(objectStatus([{ photo_count: 0 }]), 'Не начато');
  assert.equal(objectStatus([{ photo_count: 1 }, { photo_count: 0 }]), 'В работе');
  assert.equal(objectStatus([{ photo_count: 2 }]), 'Готово');
});

test('сводка по районам и АвД считает точки, отснятые точки и готовые объекты', () => {
  const summary = summarizeTpu({
    objects,
    points: [point('tpu:1', 'Аэропорт', 1, '2026-10-05T08:00:00Z'), point('tpu:1', 'Аэропорт', 0), point('parking:2', 'АвД САО', 3, '2026-10-06T09:00:00Z'), point('tpu:unknown', 'Аэропорт', 5)],
    daily: [{ day: '2026-10-06', photos: 3, points: 1 }],
    generatedAt: new Date('2026-10-06T12:00:00Z'),
    days: 3,
  });
  const airport = summary.groupRows.find((r) => r.group === 'Аэропорт');
  assert.deepEqual([airport.tpu, airport.parking, airport.withoutPoints, airport.points, airport.shot, airport.done], [2, 0, 1, 2, 1, 0]);
  const avd = summary.groupRows.find((r) => r.group === 'АвД САО');
  assert.deepEqual([avd.parking, avd.points, avd.shot, avd.done], [1, 1, 1, 1]);
  assert.deepEqual([summary.total.points, summary.total.shot, summary.total.done], [3, 2, 1]);
  assert.equal(summary.pointRows.length, 3, 'точки чужих объектов в сводку не попадают');
  assert.deepEqual(summary.dynamics.map((d) => [d.date, d.photos]), [['2026-10-04', 0], ['2026-10-05', 0], ['2026-10-06', 3]]);
});

test('последнее фото выбирается по времени, даже если база отдаёт Date', () => {
  const summary = summarizeTpu({ objects, points: [point('tpu:1', 'Аэропорт', 1, new Date('2026-09-30T23:00:00Z')), point('tpu:1', 'Аэропорт', 1, new Date('2026-10-02T08:00:00Z'))] });
  assert.equal(summary.objectRows[0].lastPhotoAt, '2026-10-02T08:00:00.000Z');
});

test('книга Excel содержит четыре листа и все 4 002 объекта карты', async () => {
  // 29 ТПУ, 65 парковок с контуром и 3 908 парковок и карманов из выгрузки АСУ ОДХ.
  assert.equal(TPU_OBJECTS.length, 4002);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await buildTpuReport(summarizeTpu({ points: [], generatedAt: new Date('2026-10-06T12:00:00Z') })));
  assert.deepEqual(book.worksheets.map((s) => s.name), ['Сводка', 'Объекты', 'Точки', 'Динамика']);
  assert.equal(book.getWorksheet('Объекты').rowCount, 4003);
  const overview = book.getWorksheet('Сводка');
  assert.equal(overview.getRow(overview.rowCount).getCell(1).value, 'Итого');
  assert.equal(overview.getRow(overview.rowCount).getCell(2).value, 29);
  assert.equal(overview.getRow(overview.rowCount).getCell(3).value, 3973);
});

test('сводка по парковкам — отдельная книга по эталону префектуры', async () => {
  const summary = summarizeTpu({ objects, kind: 'parking', points: [point('tpu:1', 'Аэропорт', 1), point('parking:2', 'АвД САО', 2, '2026-10-06T09:00:00Z')] });
  assert.deepEqual(summary.objectRows.map((r) => r.id), ['parking:2']);
  assert.deepEqual(summary.groupRows.map((r) => r.group), ['АвД САО']);
  assert.equal(summary.pointRows.length, 1, 'точки ТПУ в сводку по парковкам не попадают');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await buildTpuReport(summarizeTpu({ kind: 'parking', points: [], generatedAt: new Date('2026-10-22T09:47:00Z') })));
  assert.deepEqual(book.worksheets.map((s) => s.name), ['Свод по районам', 'Объекты', 'На доработке']);
  const overview = book.getWorksheet('Свод по районам');
  assert.match(overview.getRow(1).getCell(1).value, /Свод по фото парковок на/);
  assert.equal(overview.getRow(4).getCell(2).value, 'Всего Объектов');
  assert.equal(overview.getRow(4).getCell(5).value, 'Обьектов на проверке');
  const last = overview.getRow(overview.rowCount);
  assert.equal(last.getCell(1).value, 'Парковочные карманы');
  const parkingRow = overview.getRow(overview.rowCount - 1);
  assert.equal(parkingRow.getCell(1).value, 'Автомобильные парковки');
  assert.equal(parkingRow.getCell(2).value, 633);
  const итого = overview.getRow(overview.rowCount - 2);
  assert.equal(итого.getCell(1).value, 'Вид объекта');
  const rows = book.getWorksheet('Объекты');
  assert.equal(rows.rowCount, 3974);
  const types = new Set(rows.getColumn(1).values.slice(2));
  assert.deepEqual([...types].sort(), ['Парковка', 'Парковочный карман'], 'карман подписан своим типом, а не «Парковка»');
  assert.equal(book.getWorksheet('На доработке').getRow(2).getCell(1).value, 'Слотов на доработке нет.');
});

test('книга парковок оформлена по эталону: жёлтый титул, зелёные шапки, проценты и ссылка', async () => {
  const objects = [
    { id: 'tpu:1', kind: 'tpu', label: 'ТПУ один', sourceNumber: '1', group: 'Аэропорт', district: 'Аэропорт', holder: 'Жилищник Аэропорт' },
    { id: 'parking:2', kind: 'parking', label: 'Парковка два', sourceNumber: '2', group: 'АвД САО', district: 'Сокол', holder: 'АвД САО', type: 'Парковка', photos: 2 },
    { id: 'parking:3', kind: 'parking', label: 'Карман три', sourceNumber: '3', group: 'Коптево', district: 'Сокол', holder: 'Жилищник Сокол', type: 'Парковочный карман' },
  ];
  const slots = [
    { object_key: 'parking:2', slot: 1, status: 'accepted', review_comment: '', uploaded_at: '2026-10-06T09:00:00Z' },
    { object_key: 'parking:2', slot: 2, status: 'pending', review_comment: '', uploaded_at: '2026-10-06T09:30:00Z' },
  ];
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await buildTpuReport(summarizeTpu({ objects, kind: 'parking', points: [point('parking:2', 'АвД САО', 2, '2026-10-06T09:30:00Z')], slots, generatedAt: new Date('2026-10-22T09:47:00Z') })));
  const overview = book.getWorksheet('Свод по районам');
  const title = overview.getRow(1);
  assert.equal(title.font.bold, true);
  assert.equal(title.fill.fgColor.argb, 'FFFFFF00');
  assert.equal(overview.getRow(2).fill.fgColor.argb, 'FFFFFF00');
  const header = overview.getRow(4);
  assert.equal(header.getCell(3).fill.fgColor.argb, 'FF123A32');
  assert.equal(header.font.color.argb, 'FFFFFFFF');
  assert.equal(overview.getCell('G5').numFmt, '0%');
  assert.equal(overview.views[0].ySplit, 4);
  const rows = book.getWorksheet('Объекты');
  const row = rows.getRow(2);
  assert.equal(row.getCell(10).fill.fgColor.argb, 'FFDCE8FB', 'статус слота окрашен по палитре эталона');
  assert.match(row.getCell(12).hyperlink, /tpu-parking\.html\?object=parking%3A2$/, 'ссылка на карту ведёт на объект');
  const rework = book.getWorksheet('На доработке');
  assert.equal(rework.getRow(1).getCell(4).value, 'Что исправить');
  assert.equal(rework.views[0].ySplit, 1);
});

async function request(role, query = '', counts = []) {
  const calls = [];
  const repository = { async listSlotCounts() { return counts; }, async tpuReportData(args) { calls.push(args); return { points: [point('tpu:800905601', 'АвД САО', 1, '2026-10-06T09:00:00Z')], daily: [] }; } };
  const app = express();
  app.use('/object-photo-points', createObjectPhotoPointsRouter({
    repository,
    authenticate: (req, _res, next) => { req.user = { id: 'u', sub: 'u', role, district: role === 'district_editor' ? 'Аэропорт' : null }; next(); },
    boundary: { type: 'FeatureCollection', features: [] },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/object-photo-points/report.xlsx${query}`);
    return { status: response.status, type: response.headers.get('content-type'), name: response.headers.get('content-disposition'), calls, body: Buffer.from(await response.arrayBuffer()) };
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

test('сводку по ТПУ скачивает только префектура', async () => {
  for (const role of ['district_editor', 'reviewer']) assert.equal((await request(role)).status, 403);
  const ok = await request('prefecture_admin');
  assert.equal(ok.status, 200);
  assert.match(ok.type, /spreadsheetml/);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(ok.body);
  assert.equal(book.getWorksheet('Точки').rowCount, 2);
  assert.equal(ok.calls[0].kind, 'tpu', 'без параметра выгружается сводка по ТПУ');
  const parking = await request('prefecture_admin', '?kind=parking');
  assert.equal(parking.status, 200);
  assert.equal(parking.calls[0].kind, 'parking');
  assert.match(parking.name, /Svodka_Parkovki_SAO_/);
  assert.equal((await request('prefecture_admin', '?kind=stops')).status, 400);
});

test('сводка показывает проверку фото по слотам и что исправить', async () => {
  const objects = [{ id: 'parking:7', kind: 'parking', label: 'Карман', sourceNumber: '7', group: 'Коптево', district: 'Коптево', holder: 'Жилищник Коптево', type: 'Парковочный карман', photos: 2 }];
  const slots = [
    { object_key: 'parking:7', slot: 1, status: 'accepted', review_comment: '', uploaded_at: '2026-10-06T09:00:00Z' },
    { object_key: 'parking:7', slot: 2, status: 'rejected', review_comment: 'Не видно разметку', uploaded_at: '2026-10-06T09:00:00Z', reviewed_at: '2026-10-06T10:00:00Z' },
  ];
  const summary = summarizeTpu({ objects, kind: 'parking', points: [], slots });
  assert.equal(summary.objectRows[0].slotStatus, 'На доработке');
  assert.equal(summary.objectRows[0].slotsRequired, 2);
  assert.equal(summary.objectRows[0].slotsAccepted, 1);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await buildTpuReport(summary));
  const row = book.getWorksheet('Объекты').getRow(2);
  assert.equal(row.getCell(10).value, 'На доработке', 'статус объекта по слотам');
  assert.equal(row.getCell(6).value, 1, 'живое фото одно — принятое');
  assert.equal(row.getCell(8).value, 0);
  assert.equal(row.getCell(9).value, 1, 'один слот ждёт пересдачи');
  const rework = book.getWorksheet('На доработке');
  assert.deepEqual(rework.getRow(2).values.slice(1, 5), ['Коптево', 'Карман', 2, 'Не видно разметку']);
});

test('сводка ТПУ учитывает изменённое префектурой число слотов', async () => {
  const response = await request('prefecture_admin', '', [{ object_key: 'tpu:800905601', required: 3 }]);
  assert.equal(response.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(response.body);
  const sheet = book.getWorksheet('Объекты');
  const index = sheet.getColumn(3).values.indexOf('800905601');
  assert.equal(sheet.getRow(index).getCell(12).value, 3);
});
