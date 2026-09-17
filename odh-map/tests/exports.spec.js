// Проверки выгрузок с карты ОДХ: файлы собираются в браузере из тех же слоёв,
// что нарисованы на карте, поэтому числа берём не из фикстур, а из настоящих
// слоёв и сверяем с тем, что опубликовано в README карты.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test as base } from './fixtures.js';

const baseURL = 'http://127.0.0.1:8766/odh-map/';

// ExcelJS грузится с CDN. В тестах подставляем копию из соседнего проекта,
// иначе проверка зависит от доступности чужого сервера; если копии нет —
// запрос уходит в сеть как в браузере.
const EXCELJS_CDN = /cdn\.jsdelivr\.net\/npm\/exceljs@/;
const localExcelJs = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../photo-service/node_modules/exceljs/dist/exceljs.min.js'
);

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

const EXPORT_BUTTONS = ['#export-register', '#export-headquarters', '#export-headquarters-pdf', '#export-routes-csv'];

async function openMap(page) {
  await page.goto(baseURL);
  await expect(page.locator('#export-register')).toBeEnabled();
}

test('выгрузки становятся доступны после загрузки слоёв карты', async ({ page }) => {
  await page.goto(baseURL);
  for (const button of EXPORT_BUTTONS) await expect(page.locator(button)).toBeEnabled();
  await expect(page.locator('#export-note')).toContainText('числа те же, что на карте');
  await expect(page.locator('#export-register')).toContainText('Excel: полный реестр');
});

test('CSV по маршрутам отдаётся файлом с BOM, всеми районами и строкой ИТОГО', async ({ page }) => {
  await openMap(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-routes-csv').click()
  ]);

  expect(download.suggestedFilename()).toMatch(/^odh-routes-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync(await download.path(), 'utf8');
  const lines = csv.trim().split('\r\n');

  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(lines[0]).toBe('Район;Объектов;Точек;I очередь;II очередь;III очередь;Площадь, м²');

  const byName = new Map(lines.slice(1, -1).map((line) => [line.split(';')[0], line.split(';')]));
  expect(byName.size).toBe(17);
  for (const district of ['Аэропорт', 'Молжаниновский', 'Хорошевский', 'АвД САО']) {
    expect(byName.has(district)).toBe(true);
  }
  // Две единицы счёта: объектов по ID меньше, чем геометрических точек.
  const [objects, points] = byName.get('Хорошевский').slice(1, 3).map(Number);
  expect(objects).toBeLessThan(points);
  expect(objects).toBeGreaterThan(0);

  // Итог сходится с числами карты: 688 объектов ОДХ и 881 геометрическая часть.
  const totals = lines.at(-1).split(';');
  expect(totals[0]).toBe('ИТОГО');
  expect(totals[1]).toBe('688');
  expect(totals[2]).toBe('881');
  expect(totals.slice(3, 6)).toEqual(['155', '413', '313']);
  expect(Number(totals[6])).toBeGreaterThan(0);
});

test('книга реестра содержит листы слоёв и таблицу на штаб со светофором', async ({ page }) => {
  await openMap(page);
  const info = await page.evaluate(async () => {
    const manifest = await fetch('layers.json').then((response) => response.json());
    const layerData = {};
    for (const item of manifest.layers) {
      layerData[item.key] = await fetch(item.url).then((response) => response.json());
    }
    const model = window.ODHExports.collect(layerData);
    const workbook = window.ODHExports.buildWorkbook(model, window.ExcelJS, 'register');
    const sheet = workbook.getWorksheet('На штаб');
    return {
      sheets: workbook.worksheets.map((worksheet) => worksheet.name),
      overall: model.overall,
      groups: model.groups.map((group) => ({ title: group.title, plan: group.plan, fact: group.fact, percent: group.percent })),
      header: [1, 3, 6, 9, 12].map((column) => sheet.getCell(1, column).value),
      subHeader: ['Объекты', 'Факт', '%'].map((_, offset) => sheet.getCell(2, 3 + offset).value),
      totalLabel: sheet.getCell(1 + 2 + model.districts.length, 1).value,
      percentFill: sheet.getCell(3, 14).fill?.fgColor?.argb,
      percentFormat: sheet.getCell(3, 14).numFmt,
      columnCount: window.ODHExports.headquartersColumns(model).count
    };
  });

  expect(info.sheets).toEqual([
    'Обзор', 'На штаб', 'Районы',
    'ОДХ I очередь', 'ОДХ II очередь', 'ОДХ III очередь',
    'Контейнеры ПГМ', 'Хранение СММ', 'Снег — складирование', 'Сухие свалки снега',
    'Здравоохранение', 'Пожарные гидранты'
  ]);
  // ExcelJS отклоняет книгу целиком, если имя листа содержит * ? : \ / [ ] или
  // длиннее 31 символа. Проверяем имена до сборки, иначе ошибка всплывёт у
  // заказчика при скачивании.
  for (const name of info.sheets) {
    expect(name, `имя листа «${name}»`).not.toMatch(/[*?:\\/[\]]/);
    expect(name.length, `длина имени «${name}»`).toBeLessThanOrEqual(31);
  }
  expect(info.columnCount).toBe(14);
  expect(info.header).toEqual(['№', 'ОДХ: I–III очереди', 'Контейнеры ПГМ', 'Прочие объекты карты', 'Итого']);
  expect(info.subHeader).toEqual(['Объекты', 'Факт', '%']);
  expect(info.totalLabel).toBe('ИТОГО по САО');

  // Очереди ОДХ утверждены полностью, остальные слои — координаты-кандидаты.
  const odh = info.groups.find((group) => group.title === 'ОДХ: I–III очереди');
  expect(odh).toEqual({ title: 'ОДХ: I–III очереди', plan: 881, fact: 881, percent: 100 });
  const pgm = info.groups.find((group) => group.title === 'Контейнеры ПГМ');
  expect(pgm).toEqual({ title: 'Контейнеры ПГМ', plan: 215, fact: 0, percent: 0 });
  expect(info.overall).toEqual({ plan: 1570, fact: 904, percent: 58 });

  // Процент — целое число с заливкой светофора.
  expect(info.percentFormat).toBe('0"%"');
  expect(['FFEA9999', 'FFF4CCCC', 'FFFFF2CC', 'FFD9EAD3']).toContain(info.percentFill);
});

test('кнопка Excel отдаёт настоящую книгу, а не пустой файл', async ({ page }) => {
  await openMap(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-register').click()
  ]);

  expect(download.suggestedFilename()).toBe('sao-odh-register.xlsx');
  const bytes = readFileSync(await download.path());
  // Книга — это ZIP: без подписи PK её не откроет ни Excel, ни LibreOffice.
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(bytes.length).toBeGreaterThan(20_000);
});

test('кнопка PDF открывает печатную форму таблицы на штаб', async ({ page }) => {
  await openMap(page);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('#export-headquarters-pdf').click()
  ]);
  await popup.waitForLoadState('domcontentloaded');

  await expect(popup.locator('h1')).toHaveText('Готовность слоёв карты ОДХ');
  await expect(popup.locator('table')).toHaveCount(2);
  await expect(popup.locator('tr.total td').first()).toHaveText('ИТОГО по САО');
  await expect(popup.locator('pre')).toContainText('Направление — «Готовность слоёв карты ОДХ»');
  await expect(popup.locator('p.note')).toContainText('Колонка «Объекты» — точки на карте');
});
