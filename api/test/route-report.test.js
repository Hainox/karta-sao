import assert from 'node:assert/strict';
import test from 'node:test';
import { routeReport, routeReportCsv, routeReportCsvName, routeReportSummary } from '../lib/route-report.js';

const GENERATED_AT = new Date('2026-09-16T12:00:00.000Z');

// Строка отчёта: сколько объектов одного типа набралось у района в одном статусе.
function row(district, status, change_type, count, lastSubmittedAt = '2026-09-16T10:30:00.000Z') {
  return { district, status, change_type, count, lastSubmittedAt };
}

test('относит объекты к маршрутам, зонам и точкам по change_type', () => {
  const report = routeReport([
    row('Аэропорт', 'submitted', 'queue', 2),
    row('Аэропорт', 'submitted', 'rotor_transfer', 1),
    row('Аэропорт', 'submitted', 'dkm_route', 1),
    row('Аэропорт', 'submitted', 'tu_route', 1),
    row('Аэропорт', 'submitted', 'tu_route_yards', 1),
    row('Аэропорт', 'submitted', 'rotor_snow_storage_zone', 3),
    row('Аэропорт', 'submitted', 'pgm', 4),
    row('Аэропорт', 'submitted', 'unknown_future_type', 2)
  ], { generatedAt: GENERATED_AT });

  const airport = report.districts.find((item) => item.district === 'Аэропорт');
  assert.equal(airport.routes, 6, 'пять типов маршрутов плюс ещё один queue');
  assert.equal(airport.zones, 3, 'зона складирования идёт в зоны');
  assert.equal(airport.points, 6, 'точки ПГМ и неизвестный тип идут в точки');
});

test('раскладывает маршруты по статусам приёмки и считает итоги', () => {
  const report = routeReport([
    row('Аэропорт', 'submitted', 'queue', 2),
    row('Аэропорт', 'approved', 'queue', 3),
    row('Аэропорт', 'rejected', 'queue', 1),
    row('Сокол', 'approved', 'tu_route', 4),
    row('Сокол', 'approved', 'rotor_snow_storage_zone', 1)
  ], { generatedAt: GENERATED_AT });

  const airport = report.districts.find((item) => item.district === 'Аэропорт');
  assert.equal(airport.submitted, 2);
  assert.equal(airport.approved, 3);
  assert.equal(airport.rejected, 1);
  assert.equal(airport.routes, 6);
  // Зона не попадает в счёт по статусам маршрутов, а точки — в отдельную колонку.
  assert.deepEqual(report.totals, {
    routes: 10, zones: 1, points: 0, submitted: 2, approved: 7, rejected: 1, lastSubmittedAt: '2026-09-16T10:30:00.000Z'
  });
});

test('сортирует районы по убыванию маршрутов, затем по названию', () => {
  const report = routeReport([
    row('Сокол', 'submitted', 'queue', 2),
    row('Ховрино', 'submitted', 'queue', 2),
    row('Аэропорт', 'submitted', 'queue', 5),
    row('Беговой', 'submitted', 'pgm', 3)
  ], { generatedAt: GENERATED_AT });

  assert.deepEqual(report.districts.map((item) => item.district), ['Аэропорт', 'Сокол', 'Ховрино', 'Беговой']);
});

test('относит районы без маршрутов к отстающим', () => {
  const report = routeReport([
    row('Аэропорт', 'submitted', 'queue', 1),
    row('Беговой', 'submitted', 'pgm', 2),
    row('Сокол', 'submitted', 'rotor_snow_storage_zone', 1)
  ], { generatedAt: GENERATED_AT });

  assert.deepEqual(report.lagging, ['Беговой', 'Сокол']);
});

test('каждому району ставит время последней отправки', () => {
  const report = routeReport([
    row('Аэропорт', 'submitted', 'queue', 1, '2026-09-16T08:00:00.000Z'),
    row('Аэропорт', 'approved', 'queue', 1, '2026-09-16T11:45:00.000Z')
  ], { generatedAt: GENERATED_AT });

  assert.equal(report.districts[0].lastSubmittedAt, '2026-09-16T11:45:00.000Z');
  assert.equal(report.totals.lastSubmittedAt, '2026-09-16T11:45:00.000Z');
});

test('CSV начинается с BOM, разделён точкой с запятой и заканчивается строкой ИТОГО', () => {
  const report = routeReport([
    row('Аэропорт', 'submitted', 'queue', 2),
    row('Аэропорт', 'approved', 'rotor_snow_storage_zone', 1)
  ], { generatedAt: GENERATED_AT });
  const csv = routeReportCsv(report);

  assert.ok(csv.startsWith('\uFEFF'), 'в начале файла стоит BOM');
  const lines = csv.replace(/^\uFEFF/, '').trimEnd().split('\r\n');
  assert.equal(lines[0], 'Район;Маршрутов;Зон;Точек;На приёмке;Утверждено;Отклонено;Последняя отправка');
  assert.equal(lines.length, 3, 'шапка, строка района и ИТОГО');
  assert.match(lines[1], /^Аэропорт;/);
  assert.match(lines[2], /^ИТОГО;/);
});

test('в CSV числа остаются целыми без разделителей разрядов', () => {
  const report = routeReport([row('Аэропорт', 'approved', 'queue', 1234)], { generatedAt: GENERATED_AT });
  const csv = routeReportCsv(report);

  assert.match(csv, /Аэропорт;1234;0;0;0;1234;0;/);
  assert.ok(!csv.includes('1 234') && !csv.includes('1,234') && !csv.includes('1.234'), 'разделители разрядов не появляются');
});

test('имя выгрузки содержит дату отчёта', () => {
  const report = routeReport([], { generatedAt: GENERATED_AT });
  assert.equal(routeReportCsvName(report), 'odh-routes-2026-09-16.csv');
});

test('текст сводки начинается с фиксированной строки «Направление — …»', () => {
  const report = routeReport([
    row('Аэропорт', 'submitted', 'queue', 2),
    row('Сокол', 'submitted', 'rotor_snow_storage_zone', 1)
  ], { generatedAt: GENERATED_AT });
  const text = routeReportSummary(report);
  const lines = text.split('\n');

  assert.match(lines[0], /^Направление — «Отрисовка маршрутов ОДХ» — /);
  assert.match(text, /Маршрутов на карте ОДХ: 2, зон: 1, точек: 0\./);
  assert.match(text, /Больше всего маршрутов: Аэропорт — 2\./);
  assert.match(text, /Без маршрутов: Сокол\./);
});

test('пустой список наборов не ломает отчёт', () => {
  const report = routeReport([], { generatedAt: GENERATED_AT });

  assert.equal(report.generatedAt, GENERATED_AT.toISOString());
  assert.deepEqual(report.districts, []);
  assert.deepEqual(report.lagging, []);
  assert.deepEqual(report.totals, { routes: 0, zones: 0, points: 0, submitted: 0, approved: 0, rejected: 0, lastSubmittedAt: null });
  assert.ok(routeReportCsv(report).startsWith('\uFEFF'));
  assert.match(routeReportSummary(report).split('\n')[0], /^Направление — /);
});
