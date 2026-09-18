// Проверки выгрузок с карты ОДХ: файлы собираются в браузере из тех же слоёв,
// что нарисованы на карте, поэтому числа берём не из фикстур, а из настоящих
// слоёв и сверяем с тем, что опубликовано в README карты. Объекты районов,
// наоборот, приходят из сервиса ОДХ — его подменяем стабом.
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

const MAP_EXPORT_BUTTONS = ['#export-register', '#export-headquarters', '#export-headquarters-pdf', '#export-objects-csv'];

// Стаб единой базы: наборы районов с объектами разных типов. Проверяем на них
// разбор по типам — отдельно маршруты уборки и роторные перекидки, остальное в
// «Прочие объекты». Времена в ответе — ISO, показываются в московских.
// Фикстура набора: у объектов те же поля, что у настоящих — обозначение, адрес,
// очередь, автор. Тип можно задать строкой или объектом с дополнениями.
function features(...specs) {
  return specs.map((spec, index) => {
    const extra = typeof spec === 'string' ? {} : spec;
    const type = typeof spec === 'string' ? spec : spec.change_type;
    return { type: 'Feature', properties: { object_no: index + 1, ...extra, change_type: type } };
  });
}

const FAKE_SUBMISSIONS = [
  {
    district: 'Аэропорт', author: 'Иванов И.И.', status: 'submitted', submitted_at: '2026-09-17T06:30:00.000Z',
    change_set: {
      features: features(
        { change_type: 'queue', queue_priority: '1', address: 'Тестовая улица' },
        'queue', 'queue', 'rotor_transfer'
      )
    }
  },
  {
    district: 'Головинский', status: 'approved', submitted_at: '2026-09-16T09:00:00.000Z',
    change_set: { features: features('queue', 'queue', 'rotor_snow_storage_zone', 'temporary_snow_storage') }
  },
  {
    district: 'Дмитровский', status: 'rejected', submitted_at: '2026-09-15T12:20:00.000Z',
    change_set: { features: features('queue') }
  }
];
// Счётчик приёмки служба отдаёт готовыми числами: те же цифры, что давали наборы
// выше, чтобы проверка ловила отображение, а не пересчёт.
const FAKE_STATS = {
  sets: { total: 3, submitted: 1, approved: 1, rejected: 1 },
  objects: { total: 9, submitted: 4, approved: 4, rejected: 1 },
  lastDistrict: 'Аэропорт',
  lastSubmittedAt: '2026-09-17T06:30:00.000Z',
  checkedAt: '2026-09-17T09:00:00.000Z'
};
const FAKE_CSV = '\uFEFFРайон;Маршрутов;Зон;Точек;На приёмке;Утверждено;Отклонено;Последняя отправка\r\n'
  + 'Аэропорт;4;1;0;4;0;0;17.09.2026 09:30\r\nИТОГО;9;1;2;4;4;1;17.09.2026 09:30\r\n';

const testApi = 'https://api.test/odh';

// Страница живёт на GitHub Pages, а служба — на своём домене: браузер обязан
// увидеть настоящие заголовки CORS, поэтому стаб их отдаёт и отвечает на
// предварительный запрос. Без этого проверка ловила бы отказ браузера, а не код.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': '*'
};

async function stubApi(page) {
  await page.route('https://api.test/**', async (route) => {
    const url = route.request().url();
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS });
    }
    if (url.endsWith('/api/auth/login')) {
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ token: 'test-token', user: { email: 'префектура', role: 'prefecture_admin' } })
      });
    }
    if (url.endsWith('/api/reports/routes.csv')) {
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'text/csv; charset=utf-8',
        body: Buffer.from(FAKE_CSV, 'utf8')
      });
    }
    if (url.endsWith('/api/submissions/stats')) {
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify(FAKE_STATS)
      });
    }
    if (url.endsWith('/api/submissions')) {
      return route.fulfill({
        status: 200,
        headers: CORS,
        contentType: 'application/json',
        body: JSON.stringify({ submissions: FAKE_SUBMISSIONS })
      });
    }
    return route.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{}' });
  });
}

async function openMap(page) {
  await page.goto(baseURL);
  await expect(page.locator('#export-register')).toBeEnabled();
}

/** Вход префектуры и загрузка объектов ровно теми же шагами, что делает человек. */
async function connectBase(page) {
  await stubApi(page);
  await page.locator('#routes-api-base').fill(testApi);
  await page.locator('#routes-api-email').fill('префектура');
  await page.locator('#routes-api-password').fill('test-password');
  await page.locator('#routes-login').click();
  // Счётчик приёмки после входа сам берёт данные из базы, поэтому сводка
  // появляется без нажатия «Загрузить».
  await expect(page.locator('#routes-note')).toContainText('объектов 9');
  await page.locator('#routes-load').click();
  await expect(page.locator('#routes-note')).toContainText('объектов 9');
  await expect(page.locator('#review-live')).toBeVisible();
}

test('выгрузки становятся доступны после загрузки слоёв карты', async ({ page }) => {
  await page.goto(baseURL);
  for (const button of MAP_EXPORT_BUTTONS) await expect(page.locator(button)).toBeEnabled();
  await expect(page.locator('#export-note')).toContainText('числа те же, что на карте');
  await expect(page.locator('#export-register')).toContainText('Excel: полный реестр');
  await expect(page.locator('#export-objects-csv')).toContainText('CSV: объекты ОДХ по районам');

  // До входа в единую базу срез объектов районов закрыт: и загрузка, и выгрузка.
  await expect(page.locator('#routes-load')).toBeDisabled();
  await expect(page.locator('#export-routes-csv')).toBeDisabled();
  await expect(page.locator('#export-routes-board')).toBeDisabled();
  await expect(page.locator('#routes-note')).toContainText('Вход не выполнен');
});

test('CSV по объектам ОДХ отдаётся файлом с BOM, всеми районами и строкой ИТОГО', async ({ page }) => {
  await openMap(page);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-objects-csv').click()
  ]);

  // Имя отличается от odh-routes-<дата>.csv: под ним выгружается отчёт службы,
  // и два разных файла не должны называться одинаково.
  expect(download.suggestedFilename()).toMatch(/^sao-odh-objekty-\d{4}-\d{2}-\d{2}\.csv$/);
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
    let baseRow = 0;
    sheet.eachRow((row, index) => {
      if (String(row.getCell(1).value || '').startsWith('Объекты районов')) baseRow = index;
    });
    return {
      sheets: workbook.worksheets.map((worksheet) => worksheet.name),
      overall: model.overall,
      groups: model.groups.map((group) => ({ title: group.title, plan: group.plan, fact: group.fact, percent: group.percent })),
      header: [1, 3, 6, 9, 12].map((column) => sheet.getCell(1, column).value),
      subHeader: ['Объекты', 'Факт', '%'].map((_, offset) => sheet.getCell(2, 3 + offset).value),
      totalLabel: sheet.getCell(1 + 2 + model.districts.length, 1).value,
      percentFill: sheet.getCell(3, 14).fill?.fgColor?.argb,
      percentFormat: sheet.getCell(3, 14).numFmt,
      columnCount: window.ODHExports.headquartersColumns(model).count,
      baseTitle: baseRow ? sheet.getCell(baseRow, 1).value : null,
      baseEmpty: baseRow ? sheet.getCell(baseRow + 1, 1).value : null
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

  // Блок объектов районов на месте и без сервиса: пустой блок читался бы как
  // «районы ничего не прислали».
  expect(info.baseTitle).toBe('Объекты районов в единой базе');
  expect(info.baseEmpty).toBe('Данные единой базы не загружены: подключитесь к сервису ОДХ и повторите выгрузку.');
});

test('загруженные объекты районов попадают в книгу с разбивкой по типам', async ({ page }) => {
  await openMap(page);
  await connectBase(page);

  const block = await page.evaluate(() => {
    const model = window.exportModel();
    const sheet = window.ODHExports.buildWorkbook(model, window.ExcelJS, 'headquarters').getWorksheet('На штаб');
    let titleRow = 0;
    sheet.eachRow((row, index) => {
      if (String(row.getCell(1).value || '').startsWith('Объекты районов')) titleRow = index;
    });
    const columns = window.ODHExports.baseColumns().length;
    const values = (row) => Array.from({ length: columns }, (_, index) => sheet.getCell(row, index + 1).value);
    const first = titleRow + 2;
    const total = first + model.base.districts.length;
    return {
      title: sheet.getCell(titleRow, 1).value,
      header: values(titleRow + 1),
      first: values(first),
      second: values(first + 1),
      third: values(first + 2),
      totalLabel: sheet.getCell(total, 1).value,
      totalNumbers: values(total).slice(2),
      lagging: sheet.getCell(total + 1, 1).value,
      note: sheet.getCell(total + 2, 1).value,
      laggingCount: model.base.lagging.length
    };
  });

  expect(block.title).toBe('Объекты районов в единой базе');
  expect(block.header).toEqual([
    '№', 'Район', 'Маршруты уборки', 'Роторные перекидки', 'Прочие объекты',
    'Всего', 'На приёмке', 'Утверждено', 'Отклонено', 'Последняя отправка'
  ]);
  // Строки идут по убыванию: сначала те, кто больше прислал.
  expect(block.first).toEqual([1, 'Аэропорт', 3, 1, 0, 4, 4, 0, 0, '17.09.2026 09:30']);
  expect(block.second).toEqual([2, 'Головинский', 2, 0, 2, 4, 0, 2, 0, '16.09.2026 12:00']);
  expect(block.third).toEqual([3, 'Дмитровский', 1, 0, 0, 1, 0, 0, 1, '15.09.2026 15:20']);
  expect(block.totalLabel).toBe('ИТОГО');
  expect(block.totalNumbers).toEqual([6, 1, 2, 9, 4, 2, 1, '17.09.2026 09:30']);

  // Четырнадцать районов ничего не прислали — они обязаны быть в списке: иначе
  // пропущенная строка читалась бы как «район не учли».
  expect(block.laggingCount).toBe(14);
  expect(block.lagging).toMatch(/^Без объектов \(14\): АвД САО, Беговой/);
  // Состав «Прочих объектов» перечислен: свёрнутая колонка без расшифровки — загадка.
  expect(block.note).toContain('Временное складирование снега — 1');
  expect(block.note).toContain('Зона складирования роторного снега — 1');
  // Единица счёта приёмки названа прямо: маршруты, как в CSV службы.
  expect(block.note).toContain('Колонки приёмки считают маршруты');
});

test('лист «маршруты на штаб» повторяет форму выгрузки фотофиксации', async ({ page }) => {
  await openMap(page);
  await connectBase(page);

  const board = await page.evaluate(async () => {
    const payload = await window.ODHApi.request('/api/submissions').then((response) => response.json());
    const base = window.ODHExports.collectBase(payload.submissions);
    const sheet = window.ODHExports.buildRoutesHeadquarters(base, window.ExcelJS).getWorksheet('На штаб');
    const values = (row) => Array.from({ length: 14 }, (_, index) => sheet.getCell(row, index + 1).value);
    let totalRow = 0;
    let commentRow = 0;
    sheet.eachRow((row, index) => {
      const first = String(row.getCell(1).value || '');
      if (first.startsWith('ИТОГО')) totalRow = index;
      if (first.startsWith('Направление —')) commentRow = index;
    });
    const comment = [];
    // Окно с запасом: в комментарий попадает ещё список районов без объектов.
    for (let row = commentRow; row < commentRow + 60; row += 1) {
      const line = sheet.getCell(row, 1).value;
      // Пустая строка после заголовка — часть формы, а не конец блока.
      if (line === null || line === undefined) break;
      comment.push(String(line));
    }
    return {
      sheets: window.ODHExports.buildRoutesHeadquarters(base, window.ExcelJS).worksheets.map((item) => item.name),
      groups: base.board.groups.map((group) => ({ title: group.title, plan: group.plan, fact: group.fact, percent: group.percent })),
      overall: base.board.overall,
      states: base.board.states,
      header: [1, 3, 6, 9, 12].map((column) => sheet.getCell(1, column).value),
      subHeader: ['Объекты', 'Факт', '%'].map((_, offset) => sheet.getCell(2, 3 + offset).value),
      first: values(3),
      totalLabel: sheet.getCell(totalRow, 1).value,
      totalValues: values(totalRow).slice(2),
      percentFormat: sheet.getCell(3, 5).numFmt,
      percentFill: sheet.getCell(3, 5).fill?.fgColor?.argb,
      comment,
      note: sheet.getCell(commentRow + comment.length, 1).value
        || sheet.getCell(commentRow + comment.length + 1, 1).value
    };
  });

  // Книга — один лист, как и отдельная выгрузка «на штаб» у фотофиксации.
  expect(board.sheets).toEqual(['На штаб']);
  expect(board.header).toEqual(['№', 'Маршруты', 'Зоны', 'Точки', 'Итого']);
  expect(board.subHeader).toEqual(['Объекты', 'Факт', '%']);
  expect(board.groups).toEqual([
    { title: 'Маршруты', plan: 7, fact: 2, percent: 29 },
    { title: 'Зоны', plan: 1, fact: 1, percent: 100 },
    { title: 'Точки', plan: 1, fact: 1, percent: 100 }
  ]);
  expect(board.overall).toEqual({ plan: 9, fact: 4, percent: 44 });
  // Приёмка считается по маршрутам: зона и точка из утверждённого набора
  // Головинского в эти числа не входят — так же, как в CSV службы.
  expect(board.states).toEqual({ submitted: 4, approved: 2, rejected: 1 });

  // Верхняя таблица — устойчивый справочник: районы по алфавиту.
  expect(board.first).toEqual([1, 'Аэропорт', 4, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0]);
  expect(board.totalLabel).toBe('ИТОГО по САО');
  expect(board.totalValues).toEqual([7, 2, 29, 1, 1, 100, 1, 1, 100, 9, 4, 44]);

  // Проценты — целые, со светофором; ячейка «Маршруты: %» у Аэропорта красная (0 %).
  expect(board.percentFormat).toBe('0"%"');
  expect(['FFEA9999', 'FFF4CCCC', 'FFFFF2CC', 'FFD9EAD3']).toContain(board.percentFill);

  // Комментарий по форме штабной рассылки: направление, числа, состояния приёмки.
  expect(board.comment[0]).toMatch(/^Направление — «Приёмка маршрутов ОДХ» — .+ \(МСК\)$/);
  expect(board.comment[3]).toBe('Приёмка маршрутов ОДХ: 4 из 9 объектов — 44 %.');
  expect(board.comment.join('\n')).toContain('Слабая динамика по отрисовке маршрутов!');
  expect(board.comment.join('\n')).toContain('Приёмка: на приёмке 4, утверждено 2, отклонено 1');
  expect(board.comment.join('\n')).toContain('По категориям: маршруты 29 %');
  expect(String(board.note)).toContain('сколько объектов района нарисовали');
});

test('счётчик приёмки появляется после входа и считает по состояниям', async ({ page }) => {
  await page.goto(baseURL);
  await expect(page.locator('#export-register')).toBeEnabled();
  // До входа префектуры счётчика нет: приёмка — её работа.
  await expect(page.locator('#review-live')).toBeHidden();

  await connectBase(page);
  await expect(page.locator('#review-live')).toBeVisible();
  await expect(page.locator('#review-counter .review-cell')).toHaveCount(8);

  // По фикстуре: наборов 3 (1 на приёмке, 1 утверждён, 1 отклонён),
  // объектов 9 (4 на приёмке, 4 утверждено, 1 отклонён).
  await expect(page.locator('#review-counter .review-cell b')).toHaveText([
    '1', '1', '1', '3', '4', '4', '1', '9'
  ]);
  await expect(page.locator('#review-updated')).toContainText('Приёмка разобрала 56 % объектов, утверждено 44 %');
  await expect(page.locator('#review-updated')).toContainText('последняя отправка: Аэропорт, 17.09.2026 09:30');
  // Время с секундами: иначе обновление внутри одной минуты выглядит как замерший блок.
  await expect(page.locator('#review-updated')).toContainText(/\d{2}\.\d{2}\.\d{4}, \d{2}:\d{2}:\d{2} \(МСК\)/);
});

test('выгрузка по районам: сводка и лист на каждый район с объектами', async ({ page }) => {
  await openMap(page);
  await connectBase(page);

  const book = await page.evaluate(async () => {
    const payload = await window.ODHApi.request('/api/submissions').then((response) => response.json());
    const base = window.ODHExports.collectBase(payload.submissions);
    const workbook = window.ODHExports.buildRoutesDistrictsWorkbook(base, window.ExcelJS);
    const summary = workbook.getWorksheet('Сводка по районам');
    const district = workbook.getWorksheet('Аэропорт');
    const values = (sheet, row, columns) => Array.from({ length: columns }, (_, index) => sheet.getCell(row, index + 1).value);
    let totalRow = 0;
    summary.eachRow((row, index) => {
      if (String(row.getCell(1).value || '').startsWith('ИТОГО')) totalRow = index;
    });
    return {
      sheets: workbook.worksheets.map((sheet) => sheet.name),
      summaryTitle: summary.getCell(1, 1).value,
      summaryHeader: values(summary, 2, 10),
      summaryFirst: values(summary, 3, 10),
      summaryTotal: values(summary, totalRow, 10),
      districtTitle: district.getCell(1, 1).value,
      districtHeader: values(district, 2, 12),
      districtFirst: values(district, 3, 12),
      districtNote: (() => {
        let note = null;
        district.eachRow((row) => {
          const value = String(row.getCell(1).value || '');
          if (value.startsWith('«Обозначение»')) note = value;
        });
        return note;
      })()
    };
  });

  // Лист района получают только те районы, у кого есть объекты: пустой лист отдавать нечего.
  expect(book.sheets).toEqual(['Сводка по районам', 'Аэропорт', 'Головинский', 'Дмитровский']);
  expect(book.summaryTitle).toBe('Маршруты районов: сводка по районам');
  expect(book.summaryHeader).toEqual([
    '№', 'Район', 'Всего', 'Маршруты', 'Зоны', 'Точки', 'На приёмке', 'Утверждено', 'Отклонено', 'Последняя отправка'
  ]);
  // Сводка идёт в порядке выгрузки службы: сначала те, кто больше нарисовал.
  expect(book.summaryFirst).toEqual([1, 'Аэропорт', 4, 4, 0, 0, 4, 0, 0, '17.09.2026 09:30']);
  expect(book.summaryTotal[0]).toBe('ИТОГО по САО');
  // «Утверждено» — маршруты: у Головинского утверждены 2 маршрута, зона и точка
  // идут в «Зоны» и «Точки», но не в приёмку. Так книга сходится с CSV службы.
  expect(book.summaryTotal.slice(2)).toEqual([9, 7, 1, 1, 4, 2, 1, '17.09.2026 09:30']);

  // Лист района самодостаточен: заголовок с составом и строка на каждый объект.
  expect(book.districtTitle).toBe('Аэропорт · объектов 4: Очередность уборки — 3, Роторная перекидка — 1');
  expect(book.districtHeader).toEqual([
    '№', 'Обозначение', 'Тип', 'Очередь', 'Адрес / описание', 'Координаты', 'Направление',
    'Сопло', 'Исполнитель', 'Комментарий', 'Состояние', 'Отправлено'
  ]);
  expect(book.districtFirst.slice(1, 6)).toEqual(['ОЧ-I №1', 'Очередность уборки', 'I очередь', 'Тестовая улица', '']);
  expect(book.districtFirst[10]).toBe('на приёмке');
  expect(book.districtNote).toContain('«Обозначение» — код и номер объекта, как на карте и в приёмке');
});

test('кнопка «маршруты по районам» отдаёт книгу, а не пустой файл', async ({ page }) => {
  await openMap(page);
  await connectBase(page);
  await expect(page.locator('#export-routes-districts')).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-routes-districts').click()
  ]);

  expect(download.suggestedFilename()).toMatch(/^odh-routes-po-raionam-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(bytes.length).toBeGreaterThan(8_000);
});

test('кнопка «маршруты на штаб» отдаёт книгу, а не пустой файл', async ({ page }) => {
  await openMap(page);
  await connectBase(page);
  await expect(page.locator('#export-routes-board')).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-routes-board').click()
  ]);

  expect(download.suggestedFilename()).toMatch(/^odh-routes-na-shtab-\d{4}-\d{2}-\d{2}\.xlsx$/);
  const bytes = readFileSync(await download.path());
  expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
  expect(bytes.length).toBeGreaterThan(8_000);
});

test('CSV отчёта по маршрутам скачивается из сервиса с BOM и шапкой службы', async ({ page }) => {
  await openMap(page);
  await connectBase(page);
  // Файл службы доступен префектуре сразу, независимо от загрузки наборов.
  await expect(page.locator('#export-routes-csv')).toBeEnabled();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-routes-csv').click()
  ]);

  expect(download.suggestedFilename()).toMatch(/^odh-routes-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = readFileSync(await download.path(), 'utf8');
  expect(csv.charCodeAt(0)).toBe(0xfeff);
  expect(csv.split('\r\n')[0].slice(1)).toBe('Район;Маршрутов;Зон;Точек;На приёмке;Утверждено;Отклонено;Последняя отправка');
  expect(csv).toContain('ИТОГО;9;1;2;4;4;1;');
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

test('без сервиса печатная форма помечает объекты районов как незагруженные', async ({ page }) => {
  await openMap(page);
  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('#export-headquarters-pdf').click()
  ]);
  await popup.waitForLoadState('domcontentloaded');

  await expect(popup.getByText('Объекты районов в единой базе')).toBeVisible();
  await expect(popup.getByText('Данные единой базы не загружены: подключитесь к сервису ОДХ и повторите выгрузку.')).toBeVisible();
});

test('печатная форма несёт и таблицу на штаб, и объекты районов', async ({ page }) => {
  await openMap(page);
  await connectBase(page);

  const [popup] = await Promise.all([
    page.waitForEvent('popup'),
    page.locator('#export-headquarters-pdf').click()
  ]);
  await popup.waitForLoadState('domcontentloaded');

  await expect(popup.locator('h1')).toHaveText('Готовность слоёв карты ОДХ');
  await expect(popup.locator('h2')).toHaveText([
    'То же по проценту «Итого» — в штаб',
    'Объекты районов в единой базе',
    'Комментарий к выгрузке'
  ]);
  await expect(popup.locator('table')).toHaveCount(3);
  await expect(popup.locator('tr.total td').first()).toHaveText('ИТОГО по САО');
  await expect(popup.locator('p.meta')).toContainText('объекты районов — единая база (сервис ОДХ)');
  await expect(popup.getByText('Маршруты уборки')).toBeVisible();
  await expect(popup.getByText('Роторные перекидки')).toBeVisible();
  await expect(popup.getByText(/^Без объектов \(14\): АвД САО, Беговой/)).toBeVisible();
  await expect(popup.locator('pre')).toContainText('Направление — «Готовность слоёв карты ОДХ»');
  await expect(popup.getByText('Колонка «Объекты» — точки на карте')).toBeVisible();
});
