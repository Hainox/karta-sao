/**
 * Ссылки на СЕВЕР ЖКХ в колонке D листа «Сверка».
 *
 * Установка:
 *   1. В таблице: Расширения → Apps Script.
 *   2. Вставить этот файл целиком (или только функции) и сохранить.
 *   3. Запустить функцию linkSeverAddresses → разрешить доступ.
 *   4. Чтобы ссылки не пропадали при пересборке «Сверки», в конце
 *      refreshView() добавьте строку: linkSeverAddresses();
 *
 * Почему rich text, а не =HYPERLINK(): формула с кириллическим доменом
 * в этой таблице даёт #ERROR!, а rich text ссылку — нет. Адрес берётся
 * из «Реестра» по point_id из скрытой колонки O, поэтому функция
 * восстанавливает и ячейки, где уже стоит #ERROR!.
 *
 * Кабинет СЕВЕР ЖКХ не поддерживает прямую ссылку на конкретный адрес:
 * район и адрес выбираются внутри кабинета.
 */
function linkSeverAddresses() {
  var book = SpreadsheetApp.getActive();
  var registry = book.getSheetByName('Реестр');
  var sheet = book.getSheetByName('Сверка');
  if (!registry || !sheet) throw new Error('Нет листа «Реестр» или «Сверка»');
  var last = sheet.getLastRow();
  if (last < 8) return;

  var url = 'https://xn----ctbibgy3be7b.xn--p1ai/operator';
  var data = registry.getRange(2, 1, Math.max(registry.getLastRow() - 1, 1), 17).getValues();
  var addressByPoint = {};
  data.forEach(function (row) {
    if (row[0]) addressByPoint[row[0]] = row[4];
  });

  var pointIds = sheet.getRange(8, 15, last - 7, 1).getDisplayValues();
  sheet.getRange(8, 4, last - 7, 1).setRichTextValues(pointIds.map(function (row) {
    var text = String(addressByPoint[row[0]] || '').replace(/\s+/g, ' ').trim();
    return [SpreadsheetApp.newRichTextValue().setText(text).setLinkUrl(text ? url : null).build()];
  }));
}
