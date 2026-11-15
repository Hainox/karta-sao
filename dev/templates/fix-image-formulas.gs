/**
 * Разовая починка формул в книге ДП/СП.
 *
 * Зачем: в «Сверке» формулы =IMAGE("url",4,160,120) и «На карте» записаны
 * с запятой-разделителем аргументов. В книге с локалью ru_RU это даёт
 * #ERROR!. Скрипт убирает у IMAGE() необязательные режим и размеры, а
 * «На карте» переписывает с разделителем локали и с именами листов в кавычках.
 *
 * Установка (один раз):
 *   1. В таблице: Расширения → Apps Script → «+» → новый файл,
 *      имя fix-image-formulas.
 *   2. Вставить этот код целиком.
 *   3. Выбрать функцию fixImageFormulasNow и нажать «Выполнить».
 *   4. Первый запуск попросит разрешение — это доступ к текущей книге.
 *
 * Повторный запуск безопасен: исправленные формулы не меняются.
 */

/** Разделитель аргументов формулы по локали книги. */
function fixImageSeparator_(book) {
  var locale = '';
  try { locale = String(book.getSpreadsheetLocale() || '').toLowerCase(); } catch (_) {}
  var commaDecimal = /^(ru|uk|be|de|fr|es|it|pt|nl|pl|cs|sk|hu|ro|bg|tr|fi|sv|da|nb|lt|lv|et|el|hr|sl|sr|kk|az|hy|ka|uz|ky|tg|mk|bs|sq|is)/;
  if (commaDecimal.test(locale)) return ';';
  try {
    return (1.5).toLocaleString(locale.replace(/_/g, '-') || 'en-US').indexOf(',') >= 0 ? ';' : ',';
  } catch (_) {
    return ',';
  }
}

/** Меняет только разделители аргументов, не трогая запятые внутри строк. */
function fixImageSeparators_(formula, separator) {
  var out = '';
  var quoted = false;
  for (var index = 0; index < formula.length; index += 1) {
    var symbol = formula.charAt(index);
    if (symbol === '"') {
      if (quoted && formula.charAt(index + 1) === '"') {
        out += '""';
        index += 1;
        continue;
      }
      quoted = !quoted;
      out += symbol;
    } else if (symbol === ',' && !quoted) {
      out += separator;
    } else {
      out += symbol;
    }
  }
  return out;
}

/** Переписывает проблемные формулы во всех листах книги. */
function fixImageFormulasNow() {
  var book = SpreadsheetApp.getActive();
  var separator = fixImageSeparator_(book);
  var photos = 0;
  var maps = 0;

  book.getSheets().forEach(function (sheet) {
    // Листы на «_» — архивные копии: их не переписываем, иначе теряется смысл снимка.
    if (sheet.getName().charAt(0) === '_') return;
    var lastRow = sheet.getLastRow();
    var lastCol = sheet.getLastColumn();
    if (!lastRow || !lastCol) return;
    var formulas = sheet.getRange(1, 1, lastRow, lastCol).getFormulas();
    for (var row = 0; row < formulas.length; row += 1) {
      for (var col = 0; col < formulas[row].length; col += 1) {
        var formula = formulas[row][col];
        if (!formula) continue;
        var next = formula;
        if (/^=IMAGE\(/i.test(next)) {
          next = next.replace(/[,;]\s*4\s*[,;]\s*160\s*[,;]\s*120\s*\)\s*$/, ')');
          if (next !== formula) {
            sheet.getRange(row + 1, col + 1).setFormula(next);
            photos += 1;
          }
        } else if (/^=IF\(/i.test(next) && /HYPERLINK\(/i.test(next) && /VLOOKUP\(/i.test(next)) {
          next = fixImageSeparators_(next, separator)
            .replace(/(^|[^'А-Яа-яЁёA-Za-z0-9_])Реестр!/g, "$1'Реестр'!")
            .replace(/(^|[^'А-Яа-яЁёA-Za-z0-9_])Справочники!/g, "$1'Справочники'!");
          if (next !== formula) {
            sheet.getRange(row + 1, col + 1).setFormula(next);
            maps += 1;
          }
        }
      }
    }
  });

  SpreadsheetApp.flush();
  var left = 0;
  book.getSheets().forEach(function (sheet) {
    // Архивные снимки на «_» остаются с #ERROR! намеренно — их не считаем.
    if (sheet.getName().charAt(0) === '_') return;
    var range = sheet.getDataRange();
    if (!range.getNumRows() || !range.getNumColumns()) return;
    range.getDisplayValues().forEach(function (row) {
      row.forEach(function (value) { if (value === '#ERROR!') left += 1; });
    });
  });

  var message = 'Исправлено: фото — ' + photos + ', «На карте» — ' + maps;
  if (left) message += '. Осталось #ERROR!: ' + left;
  book.toast(message, 'Формулы', 10);
}
