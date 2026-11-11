/**
 * Починка формул «Тротуаров» и переключатель страниц.
 *
 * Зачем: книга живёт в локали с десятичной запятой (ru_RU), а формулы в листах
 * «Тротуары ОДХ» и «Тротуары дворы» записаны с запятой-разделителем аргументов.
 * В такой локали это даёт #ERROR! и в «Фото», и в «На карте». Скрипт переписывает
 * только эти две колонки, беря URL из скрытой колонки R (photo_url) и собирая
 * ссылку на карту из района и номера точки.
 *
 * Установка:
 *   1. Extensions → Apps Script → «+» (новый файл) → вставить этот код.
 *   2. В существующий onOpen добавить строку sidewalkFixMenu(); (меню появится
 *      при открытии книги). Либо выполнить sidewalkFixMenu один раз из редактора.
 *   3. Меню «Тротуары · сервис» → «Починить формулы (#ERROR!)».
 *
 * Повторный запуск безопасен: формулы просто переписываются заново.
 */

var SIDEWALK_FIX_SETS = [
  { sheet: 'Тротуары ОДХ', photo: 6, map: 11, param: 'sidewalkTest' },
  { sheet: 'Тротуары дворы', photo: 7, map: 12, param: 'sidewalk' }
];

var SIDEWALK_FIX_SLUGS = {
  'Аэропорт': 'aeroport', 'Беговой': 'begovoy', 'Бескудниковский': 'beskudnikovskiy',
  'Войковский': 'voykovskiy', 'Восточное Дегунино': 'vostochnoe-degunino',
  'Головинский': 'golovinskiy', 'Дмитровский': 'dmitrovskiy',
  'Западное Дегунино': 'zapadnoe-degunino', 'Коптево': 'koptevo',
  'Левобережный': 'levoberezhnyy', 'Молжаниновский': 'molzhaninovskiy',
  'Савеловский': 'savelovskiy', 'Сокол': 'sokol', 'Тимирязевский': 'timiryazevskiy',
  'Ховрино': 'hovrino', 'Хорошевский': 'horoshevskiy'
};

/**
 * Разделитель аргументов по локали книги. Список стран с десятичной запятой
 * надёжнее, чем toLocaleString: в Apps Script он может вернуть «1.5» даже для
 * ru-RU, и тогда получаются как раз формулы с запятой и #ERROR!.
 */
function sidewalkFixSeparator_() {
  var locale = '';
  try { locale = String(SpreadsheetApp.getActive().getSpreadsheetLocale() || '').toLowerCase(); } catch (_) {}
  var commaDecimal = /^(ru|uk|be|de|fr|es|it|pt|nl|pl|cs|sk|hu|ro|bg|tr|fi|sv|da|nb|lt|lv|et|el|hr|sl|sr|kk|az|hy|ka|uz|ky|tg|mk|bs|sq|is)/;
  return commaDecimal.test(locale) ? ';' : ',';
}

/** Переписывает «Фото» и «На карте» в обоих рабочих листах. */
function sidewalkFixFormulas() {
  var book = SpreadsheetApp.getActive();
  var separator = sidewalkFixSeparator_();
  var fixed = 0;

  SIDEWALK_FIX_SETS.forEach(function (config) {
    var sheet = book.getSheetByName(config.sheet);
    if (!sheet) return;
    var last = sheet.getLastRow();
    if (last < 6) return;
    var rows = sheet.getRange(6, 1, last - 5, 20).getValues();
    var photos = [];
    var maps = [];

    rows.forEach(function (row) {
      var photoUrl = String(row[17] || '').trim();       // R — photo_url
      photos.push([photoUrl
        ? '=IMAGE("' + photoUrl.replace(/"/g, '""') + '"' + separator + '4' + separator + '160' + separator + '120)'
        : '']);

      var district = String(row[16] || row[1] || '');    // Q — district_raw
      var slug = SIDEWALK_FIX_SLUGS[district] || '';
      // ОДХ открывается по номеру точки, дворы — по point_id.
      var point = config.param === 'sidewalkTest' ? String(row[3] || '') : String(row[13] || '');
      var mapUrl = slug && point
        ? 'https://hainox.github.io/karta-sao/districts/' + slug + '.html?' + config.param + '=' + encodeURIComponent(point)
        : '';
      maps.push([mapUrl
        ? '=HYPERLINK("' + mapUrl.replace(/"/g, '""') + '"' + separator + '"На карте")'
        : '']);
    });

    sheet.getRange(6, config.photo, rows.length, 1).setFormulas(photos);
    sheet.getRange(6, config.map, rows.length, 1).setFormulas(maps);
    fixed += rows.length;
  });

  SpreadsheetApp.getActive().toast(
    'Формулы переписаны: ' + fixed + ' строк, разделитель «' + separator + '»',
    'Тротуары', 6);
}

/** Страница в «Сверке фото»: H3, всего страниц — из строки «Найдено … из N». */
function sidewalkPage_(delta) {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName('Сверка фото');
  if (!sheet) throw new Error('Нет листа «Сверка фото».');
  var cell = sheet.getRange('H3');
  var page = Math.max(1, Math.round(Number(cell.getValue()) || 1));
  var info = String(sheet.getRange('A5').getDisplayValue() || '');
  var match = info.match(/из\s+(\d+)/i);
  var pages = match ? Math.max(1, Number(match[1])) : page;
  var next = Math.min(Math.max(1, page + delta), Math.max(pages, 1));
  if (next !== page) cell.setValue(next);
  return next;
}

function sidewalkPageNext() { sidewalkPage_(1); }
function sidewalkPagePrev() { sidewalkPage_(-1); }

function sidewalkPageFirst() {
  var sheet = SpreadsheetApp.getActive().getSheetByName('Сверка фото');
  if (sheet) sheet.getRange('H3').setValue(1);
}

function sidewalkPageLast() {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName('Сверка фото');
  if (!sheet) return;
  var info = String(sheet.getRange('A5').getDisplayValue() || '');
  var match = info.match(/из\s+(\d+)/i);
  if (match) sheet.getRange('H3').setValue(Math.max(1, Number(match[1])));
}

/** Меню. Вызывать из onOpen или один раз из редактора. */
function sidewalkFixMenu() {
  SpreadsheetApp.getUi().createMenu('Тротуары · сервис')
    .addItem('Починить формулы (#ERROR!)', 'sidewalkFixFormulas')
    .addSeparator()
    .addItem('◀ Предыдущая страница', 'sidewalkPagePrev')
    .addItem('Следующая страница ▶', 'sidewalkPageNext')
    .addItem('Первая страница', 'sidewalkPageFirst')
    .addItem('Последняя страница', 'sidewalkPageLast')
    .addToUi();
}
