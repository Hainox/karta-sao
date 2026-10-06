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

test('книга Excel содержит четыре листа и все 94 объекта карты', async () => {
  assert.equal(TPU_OBJECTS.length, 94);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(await buildTpuReport(summarizeTpu({ points: [], generatedAt: new Date('2026-10-06T12:00:00Z') })));
  assert.deepEqual(book.worksheets.map((s) => s.name), ['Сводка', 'Объекты', 'Точки', 'Динамика']);
  assert.equal(book.getWorksheet('Объекты').rowCount, 95);
  const overview = book.getWorksheet('Сводка');
  assert.equal(overview.getRow(overview.rowCount).getCell(1).value, 'Итого');
  assert.equal(overview.getRow(overview.rowCount).getCell(2).value, 29);
  assert.equal(overview.getRow(overview.rowCount).getCell(3).value, 65);
});

async function request(role) {
  const repository = { async tpuReportData() { return { points: [point('tpu:800905601', 'АвД САО', 1, '2026-10-06T09:00:00Z')], daily: [] }; } };
  const app = express();
  app.use('/object-photo-points', createObjectPhotoPointsRouter({
    repository,
    authenticate: (req, _res, next) => { req.user = { id: 'u', sub: 'u', role, district: role === 'district_editor' ? 'Аэропорт' : null }; next(); },
    boundary: { type: 'FeatureCollection', features: [] },
  }));
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/object-photo-points/report.xlsx`);
    return { status: response.status, type: response.headers.get('content-type'), body: Buffer.from(await response.arrayBuffer()) };
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
});
