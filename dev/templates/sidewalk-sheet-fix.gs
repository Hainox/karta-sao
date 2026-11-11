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
    .addItem('Покрасить «% принято»', 'applyPercentColors')
    .addSeparator()
    .addItem('◀ Предыдущая страница', 'sidewalkPagePrev')
    .addItem('Следующая страница ▶', 'sidewalkPageNext')
    .addItem('Первая страница', 'sidewalkPageFirst')
    .addItem('Последняя страница', 'sidewalkPageLast')
    .addToUi();
}

/**
 * Цветовая шкала для колонок «% принято» во всех сводках книги.
 * 100 % — зелёный, 80–99 % — светло-зелёный, 60–80 % — оттенки жёлтого,
 * ниже 60 % — оттенки красного. Повторный запуск заменяет только правила
 * на этой колонке, остальное форматирование листа не трогает.
 */
function applyPercentColors() {
  var book = SpreadsheetApp.getActive();
  var bands = [
    { min: 0.9995, color: '#00B050' },
    { min: 0.8, color: '#A5D6A7' },
    { min: 0.7, color: '#FFF59D' },
    { min: 0.6, color: '#FDD835' },
    { min: 0.4, color: '#FF8A65' },
    { min: 0.2, color: '#E53935' }
  ];
  var touched = 0;

  book.getSheets().forEach(function (sheet) {
    var values = sheet.getDataRange().getValues();
    if (!values.length) return;
    var headerRow = -1;
    var column = -1;
    for (var r = 0; r < Math.min(values.length, 20) && headerRow < 0; r += 1) {
      for (var c = 0; c < values[r].length; c += 1) {
        var text = String(values[r][c] == null ? '' : values[r][c]).trim().toLowerCase();
        if (text.indexOf('% принято') === 0) { headerRow = r; column = c; break; }
      }
    }
    if (column < 0) return;

    var last = headerRow;
    for (var i = headerRow + 1; i < values.length; i += 1) {
      var value = values[i][column];
      if (value === '' || value === null) break;
      last = i;
    }
    if (last <= headerRow) return;

    var range = sheet.getRange(headerRow + 2, column + 1, last - headerRow, 1);

    var rules = sheet.getConditionalFormatRules().filter(function (rule) {
      return !rule.getRanges().some(function (existing) {
        return !(existing.getLastRow() < range.getRow() || existing.getRow() > range.getLastRow()
          || existing.getLastColumn() < range.getColumn() || existing.getColumn() > range.getLastColumn());
      });
    });

    bands.forEach(function (band) {
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenNumberGreaterThanOrEqualTo(band.min)
        .setBackground(band.color)
        .setRanges([range])
        .build());
    });
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberLessThan(0.2)
      .setBackground('#B71C1C')
      .setRanges([range])
      .build());

    sheet.setConditionalFormatRules(rules);
    touched += 1;
  });

  book.toast('Покрашено сводок: ' + touched, 'Проценты', 5);
}
