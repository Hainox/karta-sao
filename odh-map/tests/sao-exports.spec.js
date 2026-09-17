// Выгрузка объектов корневой карты по районам и участкам. Проверяем сам разбор
// (участок из данных и по геометрии) и книгу: сводки, лист на район, итоги.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from './fixtures.js';

const rootURL = 'http://127.0.0.1:8766/';
const EXCELJS_CDN = /cdn\.jsdelivr\.net\/npm\/exceljs@/;
const localExcelJs = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../photo-service/node_modules/exceljs/dist/exceljs.min.js'
);

// ExcelJS грузится с CDN: в тестах подставляем копию из соседнего проекта, иначе
// проверка зависит от доступности чужого сервера.
const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(EXCELJS_CDN, async (route) => {
      if (!existsSync(localExcelJs)) return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript; charset=utf-8',
        body: readFileSync(localExcelJs)
      });
    });
    await use(page);
  }
});

const ring = (minX, minY, maxX, maxY) => [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY], [minX, minY]];

const yard = (id, district, section, bounds) => ({
  id,
  layerKey: 'areas',
  district,
  section,
  name: `Двор ${id}`,
  geometry: { type: 'Polygon', coordinates: [ring(...bounds)] },
  properties: { 'Площадь': '1000 кв.м', 'Уборочная': '800 кв.м', 'Статус': 'Утвержден' }
});

const object = (id, layerKey, district, section, coordinates, properties = {}) => ({
  id,
  layerKey,
  district,
  section,
  name: `${layerKey} ${id}`,
  geometry: { type: 'Point', coordinates },
  properties
});

// Фикстура: два района с дворами, объекты разных слоёв. Урна внутри двора участок
// получает по геометрии, урна в стороне — остаётся без участка, а у одной участок
// в источнике записан как «5.0».
const RECORDS = [
  yard('yard-1', 'Аэропорт', 'Участок 1', [37.50, 55.80, 37.52, 55.82]),
  yard('yard-2', 'Аэропорт', 'Участок 3', [37.53, 55.80, 37.55, 55.82]),
  yard('yard-3', 'Беговой', 'Участок 2', [37.56, 55.80, 37.58, 55.82]),
  object('mno-1', 'mno', 'Аэропорт', 'Участок 1', [37.51, 55.81], { mno_type: 'КП', container_count: '3', address: 'Тестовый проезд, 1' }),
  object('urn-inside', 'urns', 'Аэропорт', '', [37.515, 55.815], { material: 'Металлическая', status: 'Утвержден' }),
  object('urn-outside', 'urns', 'Аэропорт', '', [37.545, 55.83], { material: 'Пластиковая' }),
  object('urn-no-district', 'urns', '', '', [37.51, 55.81], {}),
  object('urn-odd-section', 'urns', 'Беговой', '5.0', [37.57, 55.81], {}),
  object('sp-1', 'sp', 'Беговой', '', [37.575, 55.815], { type: 'Спортивная площадка', site_type: 'Резиновая крошка' })
];

test('участок берётся из данных, а без них — по попаданию в двор', async ({ page }) => {
  await page.goto(rootURL);
  const model = await page.evaluate((records) => window.SaoExports.collect(records), RECORDS);

  const byName = Object.fromEntries(model.objects.map((item) => [`${item.layerKey}:${item.name.split(' ').pop()}`, item.section]));
  expect(byName['urns:urn-inside']).toBe('Участок 1');
  expect(byName['urns:urn-outside']).toBe('Без участка');
  expect(byName['urns:urn-no-district']).toBe('Без участка');
  // «5.0» в источнике и «Участок 5» — один и тот же участок.
  expect(byName['urns:urn-odd-section']).toBe('Участок 5');
  expect(byName['sp:sp-1']).toBe('Участок 2');
  expect(model.overall.total).toBe(RECORDS.length);
  expect(model.districts.map((entry) => entry.district)).toEqual(['Аэропорт', 'Беговой', 'Без района']);
});

test('книга: сводка по районам, сводка по участкам и лист на каждый район', async ({ page }) => {
  await page.goto(rootURL);
  const book = await page.evaluate((records) => {
    const model = window.SaoExports.collect(records);
    const workbook = window.SaoExports.buildWorkbook(model, window.ExcelJS);
    const summary = workbook.getWorksheet('Сводка по районам');
    const sections = workbook.getWorksheet('По участкам');
    const airport = workbook.getWorksheet('Аэропорт');
    const values = (sheet, row, columns) => Array.from({ length: columns }, (_, index) => sheet.getCell(row, index + 1).value);
    let totalRow = 0;
    summary.eachRow((row, index) => { if (String(row.getCell(2).value || '').startsWith('ИТОГО')) totalRow = index; });
    return {
      sheets: workbook.worksheets.map((sheet) => sheet.name),
      summaryHeader: values(summary, 2, 9),
      summaryFirst: values(summary, 3, 9),
      summaryTotal: values(summary, totalRow, 9),
      sectionsHeader: values(sections, 2, 11),
      sectionsFirst: values(sections, 3, 11),
      airportHeader: values(airport, 2, 7),
      airportRows: values(airport, 3, 7),
      // Примечания идут после итоговой строки: сколько объектов и сколько без участка.
      airportNotes: [airport.getCell(airport.rowCount - 1, 1).value, airport.getCell(airport.rowCount, 1).value].map(String)
    };
  }, RECORDS);

  expect(book.sheets).toEqual(['Сводка по районам', 'По участкам', 'Аэропорт', 'Беговой', 'Без района']);
  expect(book.summaryHeader).toEqual(['№', 'Район', 'Дворы и участки', 'МНО', 'Детские площадки', 'Спортивные площадки', 'Места хранения СММ', 'Урны', 'Всего']);
  expect(book.summaryFirst).toEqual([1, 'Аэропорт', 2, 1, 0, 0, 0, 2, 5]);
  expect(book.summaryTotal).toEqual(['', 'ИТОГО по САО', 3, 1, 0, 1, 0, 4, 9]);
  expect(book.sectionsHeader.slice(0, 4)).toEqual(['№', 'Район', 'Участок', 'Дворы и участки']);
  // Первым идёт участок 1 Аэропорта: в нём двор, МНО и урна по геометрии.
  expect(book.sectionsFirst.slice(0, 4)).toEqual([1, 'Аэропорт', 'Участок 1', 1]);
  expect(book.airportHeader).toEqual(['№', 'Участок', 'Тип объекта', 'Название', 'Адрес', 'Координаты', 'Дополнительно']);
  expect(book.airportRows.slice(0, 4)).toEqual([1, 'Участок 1', 'Дворы и участки', 'Двор yard-1']);
  expect(book.airportNotes.join(' | ')).toContain('Объектов в районе: 5');
  expect(book.airportNotes.join(' | ')).toContain('Без участка: 1');
});

test('кнопка выгрузки отдаёт книгу целиком', async ({ page }) => {
  await page.goto(rootURL);
  await expect(page.locator('#status')).toContainText('Загружено: Районы и участки', { timeout: 120000 });
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 120000 }),
    page.locator('#exportButton').click()
  ]);
  expect(download.suggestedFilename()).toMatch(/^sao-objekty-po-rayonam-i-uchastkam-\d{4}-\d{2}-\d{2}\.xlsx$/);
  // Объектов ровно столько, сколько прочитано картой.
  await expect(page.locator('#status')).toContainText('Выгрузка готова', { timeout: 120000 });
  await expect(page.locator('#status')).toContainText('листов 20');
});
