import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { buildHeadquartersExcel } from '../src/exports.js';
import { buildHeadquartersPdf, headquartersPdfTables, percentBand } from '../src/pdf-headquarters.js';

// Строка отчёта в том виде, в каком её отдаёт загрузка из базы.
function reportRow(objectType, district, points, covered, balanceHolder = null) {
  return {
    object_key: `${objectType}|${district}|${points}-${covered}`,
    dataset_id: 'sao_stops',
    object_type: objectType,
    report_key: '1',
    source_ids: Array.from({ length: points }, (_, index) => `${objectType}:${index}`),
    district,
    label: 'Объект',
    reference_points: [],
    properties: {},
    source_version: 'embedded-map-2026-09-15',
    confirmedPhotos: covered > 0 ? 1 : 0,
    pendingReviewPhotos: 0,
    sourcePointCount: points,
    coveredPoints: covered,
    balance_holder: balanceHolder,
    geoRisk: false,
    photos: [],
  };
}

test('светофор в PDF идёт по тем же порогам, что и на листе «На штаб»', () => {
  // Точный ноль при плане — свой цвет, он темнее «до 33 %».
  assert.equal(percentBand(0, 10), 'zero');
  assert.equal(percentBand(32, 10), 'low');
  assert.equal(percentBand(33, 10), 'middle');
  assert.equal(percentBand(65, 10), 'middle');
  assert.equal(percentBand(66, 10), 'high');
  assert.equal(percentBand(100, 10), 'high');
  // Без плана красить нечего — полосы нет.
  assert.equal(percentBand(0, 0), null);
  assert.equal(percentBand(null, 0), null);
});

test('печатная форма PDF: строка «АвД САО», обе таблицы и одна ИТОГО-строка', () => {
  const { tables } = headquartersPdfTables([
    reportRow('stop', 'Аэропорт', 43, 2),
    reportRow('pp', 'Коптево', 10, 0),
    // Балансодержатель АвД: объект стоит в Коптеве, а счёт идёт АвД.
    reportRow('stop', 'Коптево', 100, 60, 'АвД САО'),
    // Объект без района приписать району нельзя — он тоже уходит АвД.
    reportRow('pp', null, 3, 0),
  ]);

  const [byDistrict, byPercent] = tables;
  // Верхняя таблица — районы по алфавиту, «АвД САО» последней строкой.
  assert.deepEqual(byDistrict.names, ['Аэропорт', 'Коптево', 'АвД САО']);
  // ДЭУ и объекты без района посчитаны на АвД: 100 остановок + 3 перехода.
  assert.equal(byDistrict.counts[2].plan.stop, 100);
  assert.equal(byDistrict.counts[2].plan.pp, 3);
  // Переходы Коптева остаются Коптеву: без балансодержателя они не уходят АвД.
  assert.equal(byDistrict.counts[1].plan.pp, 10);

  // Нижняя таблица — те же районы по убыванию «Итого, %»: АвД 60 из 103 (58 %),
  // Аэропорт 2 из 43 (5 %), Коптево 0 из 10 (0 %).
  assert.deepEqual(byPercent.names, ['АвД САО', 'Аэропорт', 'Коптево']);
  // Обе таблицы заканчиваются одной и той же строкой ИТОГО.
  assert.deepEqual(byDistrict.total, byPercent.total);
  assert.equal(byDistrict.total.plan.stop, 143);
  assert.equal(byDistrict.total.plan.pp, 13);
  assert.equal(byDistrict.total.fact.stop, 62);
});

test('числа PDF сходятся с листом «На штаб»: одна модель на выгрузку и PDF', async () => {
  const rows = [
    reportRow('stop', 'Аэропорт', 43, 2),
    reportRow('pp', 'Коптево', 10, 0),
    reportRow('stop', 'Коптево', 100, 60, 'АвД САО'),
    reportRow('pp', null, 3, 0),
  ];

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await buildHeadquartersExcel(rows));
  const sheet = workbook.getWorksheet('На штаб');
  const totalRow = sheet.getColumn(1).values.findIndex((value) => value === 'ИТОГО по САО');
  const { tables } = headquartersPdfTables(rows);
  const [byDistrict] = tables;

  // ИТОГО на листе и в печатной форме — одни и те же отметки по каждой категории.
  // Колонки листа: L/M/N — итог, C/D, F/G, I/J — категории.
  assert.equal(sheet.getCell(`L${totalRow}`).value, byDistrict.total.plan.stop + byDistrict.total.plan.pp + byDistrict.total.plan.entrance);
  assert.equal(sheet.getCell(`M${totalRow}`).value, byDistrict.total.fact.stop + byDistrict.total.fact.pp + byDistrict.total.fact.entrance);
  assert.equal(sheet.getCell(`C${totalRow}`).value, byDistrict.total.plan.stop);
  assert.equal(sheet.getCell(`F${totalRow}`).value, byDistrict.total.plan.pp);
  assert.equal(sheet.getCell(`I${totalRow}`).value, byDistrict.total.plan.entrance);
});

test('PDF штабной таблицы: альбомная A4, кириллический шрифт, таблицы со своих страниц', async () => {
  const rows = [
    reportRow('stop', 'Аэропорт', 43, 2),
    reportRow('pp', 'Коптево', 10, 0),
    reportRow('stop', 'Коптево', 100, 60, 'АвД САО'),
  ];
  const pdf = await buildHeadquartersPdf(rows);
  const raw = pdf.toString('latin1');

  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  // Без ToUnicode кириллица копируется из PDF мусором.
  assert.match(raw, /\/FontFile2/);
  assert.match(raw, /\/ToUnicode/);
  // Альбомная A4: ширина больше высоты.
  assert.match(raw, /\/MediaBox \[0 0 841\.89 595\.28\]/);
  assert.ok(pdf.length > 5000, `PDF слишком мал: ${pdf.length} байт`);
  // Вторая таблица идёт со своей страницы.
  const pages = (raw.match(/\/Type \/Page[^s]/g) || []).length;
  assert.ok(pages >= 2, `страниц: ${pages}`);
});
