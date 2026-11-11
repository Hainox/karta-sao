/**
 * Google-таблица проверки пешеходных дорожек АСУ ОДС.
 *
 * Установка (один раз):
 *   1. Создать пустую книгу: https://sheets.new
 *   2. «Расширения» → «Apps Script». Вставить этот файл целиком.
 *   3. «Настройки проекта» → «Свойства скрипта» → добавить
 *      SAO_TOKEN = <токен служебной учётки фотослужбы>.
 *   4. Сохранить, перезагрузить книгу.
 *   5. Меню «Дорожки» → «Настроить книгу», затем «Обновить сейчас».
 *   6. Меню «Дорожки» → «Включить автообновление (10 мин)».
 *
 * Что делает:
 *   • каждые 10 минут обновляет «Реестр», «Свод» и «На доработке»;
 *   • отправляет решения из колонок R:T в кабинет;
 *   • «Принять» принимает ожидающий кадр, «Проверено» отмечает уже
 *     принятый, «Вернуть на доработку» реально отзывает снимок;
 *   • решения адресуются photo_id: устаревшая строка не тронет переснятый кадр.
 */

var PATH_CFG = {
  api: 'https://obhod-sao.ru/photo-api/object-photo-points/pedestrian-path-sheet',
  registry: 'Реестр',
  summary: 'Свод',
  rework: 'На доработке',
  log: 'Журнал',
  state: '_state',
  maxRows: 20000
};

var PATH_DISTRICTS = [
  'Аэропорт', 'Беговой', 'Бескудниковский', 'Войковский', 'Восточное Дегунино',
  'Головинский', 'Дмитровский', 'Западное Дегунино', 'Коптево', 'Левобережный',
  'Молжаниновский', 'Савеловский', 'Сокол', 'Тимирязевский', 'Ховрино', 'Хорошевский'
];

var PATH_HEADERS = [
  '№', 'Район', 'Адрес', 'Номер точки', 'ID дорожки', 'Точка', 'Длина трассы, м',
  'Площадь, м²', 'Покрытие', 'Широта', 'Долгота', 'Статус', 'Фото', 'Загружено',
  'Проверено', 'Комментарий', 'На карте', 'Решение', 'Причина', 'Комментарий проверки',
  'Отправлено', 'photo_id', 'point_id', 'map_url'
];

var PATH_SUMMARY_HEADERS = ['Район', 'Всего', 'Без фото', 'Принято', 'На проверке', 'На доработке', '% принято'];
var PATH_REWORK_HEADERS = ['№', 'Район', 'Адрес', 'Номер точки', 'ID дорожки', 'Точка',
  'Длина трассы, м', 'Площадь, м²', 'Покрытие', 'Причина возврата', 'Отклонено', 'На карте'];
var PATH_LOG_HEADERS = ['Время', 'Действие', 'Строк', 'Ошибок', 'Сообщение'];
var PATH_DECISIONS = ['Принять', 'Проверено', 'Вернуть на доработку'];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Дорожки')
    .addItem('Обновить сейчас', 'pathSync')
    .addItem('Полная пересборка', 'pathSyncFull')
    .addItem('Отправить решения', 'pathPush')
    .addSeparator()
    .addItem('Настроить книгу', 'pathSetup')
    .addItem('Покрасить «% принято»', 'applyPercentColors')
    .addSeparator()
    .addItem('Включить автообновление (10 мин)', 'pathInstallTriggers')
    .addItem('Выключить автообновление', 'pathRemoveTriggers')
    .addToUi();
}

function onEdit(event) {
  // Правка решения снимает отметку «Отправлено», чтобы решение можно было
  // исправить и отправить повторно, не очищая ячейку вручную.
  var range = event && event.range;
  if (!range || range.getSheet().getName() !== PATH_CFG.registry) return;
  if (range.getColumn() < 18 || range.getColumn() > 20 || range.getRow() < 2) return;
  var first = range.getRow();
  var count = Math.max(range.getNumRows(), 1);
  range.getSheet().getRange(first, 21, count, 1).clearContent();
}

/* ---------- настройка книги ---------- */

function pathSetup() {
  var book = SpreadsheetApp.getActive();
  var registry = pathEnsureSheet_(book, PATH_CFG.registry);
  if (registry.getMaxRows() < PATH_CFG.maxRows) {
    registry.insertRowsAfter(registry.getMaxRows(), PATH_CFG.maxRows - registry.getMaxRows());
  }
  if (registry.getMaxColumns() < 24) {
    registry.insertColumnsAfter(registry.getMaxColumns(), 24 - registry.getMaxColumns());
  }
  pathHeader_(registry, PATH_HEADERS, 24);
  registry.setFrozenRows(1);
  registry.setFrozenColumns(3);
  registry.setRowHeight(1, 36);
  var widths = [45, 150, 260, 160, 150, 60, 85, 85, 140, 95, 95, 120, 180, 130, 130, 240, 90, 150, 210, 210, 160, 120, 280, 280];
  widths.forEach(function (width, index) { registry.setColumnWidth(index + 1, width); });
  registry.hideColumns(22, 3);
  if (registry.getFilter()) registry.getFilter().remove();
  registry.getRange(1, 1, PATH_CFG.maxRows, 24).createFilter();

  var decisionRule = SpreadsheetApp.newDataValidation()
    .requireValueInList(PATH_DECISIONS, true)
    .setAllowInvalid(false)
    .build();
  registry.getRange(2, 18, PATH_CFG.maxRows - 1, 1).setDataValidation(decisionRule);
  pathStatusColors_(registry, 2, PATH_CFG.maxRows - 1);

  var summary = pathEnsureSheet_(book, PATH_CFG.summary);
  pathSummaryLayout_(summary);
  var rework = pathEnsureSheet_(book, PATH_CFG.rework);
  pathHeader_(rework, PATH_REWORK_HEADERS, 12);
  rework.setFrozenRows(1);
  rework.setRowHeight(1, 36);
  var reworkWidths = [45, 150, 260, 170, 150, 60, 85, 85, 140, 300, 130, 90];
  reworkWidths.forEach(function (width, index) { rework.setColumnWidth(index + 1, width); });

  var log = pathEnsureSheet_(book, PATH_CFG.log);
  pathHeader_(log, PATH_LOG_HEADERS, 5);
  log.setFrozenRows(1);
  log.setColumnWidth(1, 145).setColumnWidth(2, 130).setColumnWidth(3, 90)
    .setColumnWidth(4, 80).setColumnWidth(5, 500);

  var state = pathEnsureSheet_(book, PATH_CFG.state);
  state.getRange('A1').setValue('Обновлено').setFontWeight('bold');
  state.getRange('A2').setValue('Строк').setFontWeight('bold');
  state.getRange('A3').setValue('Ошибка').setFontWeight('bold');
  state.setColumnWidth(1, 120).setColumnWidth(2, 260);

  book.toast('Книга настроена. Запустите «Обновить сейчас».', 'Дорожки', 8);
}

function pathEnsureSheet_(book, name) {
  return book.getSheetByName(name) || book.insertSheet(name);
}

function pathHeader_(sheet, headers, columns) {
  var current = sheet.getRange(1, 1, 1, columns).getValues()[0];
  if (current.join('').trim() === '') sheet.getRange(1, 1, 1, columns).setValues([headers]);
  sheet.getRange(1, 1, 1, columns)
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#183C35')
    .setWrap(true).setVerticalAlignment('middle');
}

function pathSummaryLayout_(sheet) {
  sheet.getRange('A1:G1').merge();
  sheet.getRange('A1').setValue('Пешеходные дорожки · АСУ ОДС')
    .setFontSize(15).setFontWeight('bold').setFontColor('#183C35');
  sheet.getRange('A2').setValue('Обновлено:').setFontWeight('bold');
  sheet.getRange('A4:G4').setValues([PATH_SUMMARY_HEADERS])
    .setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#183C35');
  sheet.getRange(5, 1, PATH_DISTRICTS.length, 1).setValues(PATH_DISTRICTS.map(function (name) { return [name]; }));
  sheet.getRange(5 + PATH_DISTRICTS.length, 1).setValue('Итого').setFontWeight('bold');
  sheet.getRange(5, 7, PATH_DISTRICTS.length + 1, 1).setNumberFormat('0.0%');
  sheet.setFrozenRows(4);
  [220, 95, 95, 95, 115, 125, 105].forEach(function (width, index) { sheet.setColumnWidth(index + 1, width); });
  pathPercentColors_(sheet, sheet.getRange(5, 7, PATH_DISTRICTS.length + 1, 1));
}

/* ---------- синхронизация ---------- */

function pathSync() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return;
  var started = new Date();
  try {
    var props = PropertiesService.getScriptProperties();
    var since = props.getProperty('PATH_LAST_SYNC') || '';
    var data = pathFetch_(since);
    var rows = data.rows || [];
    var written;
    if (data.full || !since) {
      written = pathWriteRegistry_(rows);
    } else {
      written = pathApplyChanges_(rows);
      if (written < 0) {
        // Новая или снятая точка: инкремент не может поставить её на место,
        // поэтому один раз пересобираем реестр целиком.
        data = pathFetch_('');
        written = pathWriteRegistry_(data.rows || []);
      }
    }
    pathWriteSummary_(data.generated_at);
    pathWriteRework_();
    var total = pathRegistryCount_();
    pathWriteState_(total, data.generated_at);
    props.setProperty('PATH_LAST_SYNC', String(data.generated_at || new Date().toISOString()));
    pathLog_(started, 'sync', written, 0, data.full || !since ? 'full' : 'incremental');
  } catch (error) {
    pathLog_(started, 'sync', 0, 1, String(error && error.message || error).slice(0, 400));
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function pathSyncFull() {
  PropertiesService.getScriptProperties().deleteProperty('PATH_LAST_SYNC');
  pathSync();
}

function pathToken_() {
  var value = PropertiesService.getScriptProperties().getProperty('SAO_TOKEN');
  if (!value) throw new Error('Не задан SAO_TOKEN в свойствах скрипта');
  return value;
}

function pathFetch_(since) {
  var url = PATH_CFG.api + '/sheet.json';
  if (since) url += '?since=' + encodeURIComponent(since);
  var response = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + pathToken_() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('HTTP ' + response.getResponseCode() + ': ' + response.getContentText().slice(0, 200));
  }
  return JSON.parse(response.getContentText());
}

function pathStatus_(row) {
  if (row.photo_state === 'accepted') return 'Принято';
  if (row.photo_state === 'pending') return 'На проверке';
  if (row.photo_state === 'rework') return 'На доработке';
  return 'Нет фото';
}

function pathComment_(row) {
  return row.photo_state === 'rework' ? (row.rejected_comment || '') : (row.review_comment || '');
}

function pathFormulaSeparator_(book) {
  var locale = '';
  try { locale = String(book.getSpreadsheetLocale() || '').toLowerCase(); } catch (_) { /* старые версии */ }
  var commaDecimal = /^(ru|uk|be|de|fr|es|it|pt|nl|pl|cs|sk|hu|ro|bg|tr|fi|sv|da|nb|lt|lv|et|el|hr|sl|sr|kk|az|hy|ka|uz|ky|tg|mk|bs|sq|is)/;
  if (commaDecimal.test(locale)) return ';';
  try {
    return (1.5).toLocaleString(locale.replace(/_/g, '-') || 'en-US').indexOf(',') >= 0 ? ';' : ',';
  } catch (_) {
    return ',';
  }
}

function pathWriteRegistry_(rows) {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName(PATH_CFG.registry);
  if (!sheet) throw new Error('Нет листа «' + PATH_CFG.registry + '». Запустите «Настроить книгу».');
  var separator = pathFormulaSeparator_(book);
  var oldLast = sheet.getLastRow();
  var saved = {};
  if (oldLast >= 2) {
    sheet.getRange(2, 18, oldLast - 1, 6).getValues().forEach(function (row) {
      var pointId = String(row[5] || '');
      var photoId = String(row[4] || '');
      if (!pointId || !photoId) return;
      if (row[0] || row[3]) saved[pointId + '|' + photoId] = [row[0], row[1], row[2], row[3]];
    });
  }
  if (sheet.getMaxRows() < rows.length + 1) {
    sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  }

  var values = [];
  var photos = [];
  var maps = [];
  var hidden = [];
  var decisions = [];
  rows.forEach(function (row, index) {
    var status = pathStatus_(row);
    values.push([
      index + 1, row.district || '', row.address || '', row.point_no || '', row.path_id || '',
      row.ordinal || '', row.route_m || '', row.area || '', row.coating || '',
      row.latitude || '', row.longitude || '', status, '',
      row.uploaded_at ? new Date(row.uploaded_at) : '',
      row.reviewed_at ? new Date(row.reviewed_at) : '',
      pathComment_(row), ''
    ]);
    var photoUrl = row.photo_token ? PATH_CFG.api + '/photo-thumb/' + row.photo_token : '';
    photos.push([photoUrl
      ? '=IMAGE("' + photoUrl + '"' + separator + '4' + separator + '160' + separator + '120)'
      : '']);
    maps.push([row.map_url
      ? '=HYPERLINK("' + String(row.map_url).replace(/"/g, '""') + '"' + separator + '"На карте")'
      : '']);
    hidden.push([row.photo_id || '', row.point_id || '', row.map_url || '']);
    var key = String(row.point_id || '') + '|' + String(row.photo_id || '');
    decisions.push(saved[key] || ['', '', '', '']);
  });

  if (rows.length) {
    sheet.getRange(2, 1, rows.length, 17).setValues(values);
    sheet.getRange(2, 13, rows.length, 1).setFormulas(photos);
    sheet.getRange(2, 17, rows.length, 1).setFormulas(maps);
    sheet.getRange(2, 18, rows.length, 4).setValues(decisions);
    sheet.getRange(2, 22, rows.length, 3).setValues(hidden);
  }
  if (oldLast > rows.length + 1) {
    sheet.getRange(rows.length + 2, 1, oldLast - rows.length - 1, 24).clearContent();
  }
  return rows.length;
}

/**
 * Точечно обновляет изменившиеся строки. Если точки ещё нет на листе,
 * возвращает -1: вызывающий пересоберёт реестр целиком.
 */
function pathApplyChanges_(rows) {
  if (!rows.length) return 0;
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName(PATH_CFG.registry);
  if (!sheet) throw new Error('Нет листа «' + PATH_CFG.registry + '». Запустите «Настроить книгу».');
  var separator = pathFormulaSeparator_(book);
  var last = sheet.getLastRow();
  if (last < 2) return -1;
  var ids = sheet.getRange(2, 23, last - 1, 1).getValues();
  var rowById = {};
  ids.forEach(function (item, index) {
    if (item[0]) rowById[String(item[0])] = index + 2;
  });
  var missing = false;
  rows.forEach(function (row) {
    if (!rowById[String(row.point_id || '')]) missing = true;
  });
  if (missing) return -1;

  rows.forEach(function (row) {
    var rowNumber = rowById[String(row.point_id || '')];
    var oldPhoto = String(sheet.getRange(rowNumber, 22).getValue() || '');
    var newPhoto = String(row.photo_id || '');
    var saved = oldPhoto && oldPhoto === newPhoto
      ? sheet.getRange(rowNumber, 18, 1, 4).getValues()[0] : ['', '', '', ''];
    var status = pathStatus_(row);
    var values = [[
      rowNumber - 1, row.district || '', row.address || '', row.point_no || '', row.path_id || '',
      row.ordinal || '', row.route_m || '', row.area || '', row.coating || '',
      row.latitude || '', row.longitude || '', status, '',
      row.uploaded_at ? new Date(row.uploaded_at) : '',
      row.reviewed_at ? new Date(row.reviewed_at) : '',
      pathComment_(row), ''
    ]];
    sheet.getRange(rowNumber, 1, 1, 17).setValues(values);
    var photoUrl = row.photo_token ? PATH_CFG.api + '/photo-thumb/' + row.photo_token : '';
    sheet.getRange(rowNumber, 13).setFormula(photoUrl
      ? '=IMAGE("' + photoUrl + '"' + separator + '4' + separator + '160' + separator + '120)' : '');
    sheet.getRange(rowNumber, 17).setFormula(row.map_url
      ? '=HYPERLINK("' + String(row.map_url).replace(/"/g, '""') + '"' + separator + '"На карте")' : '');
    sheet.getRange(rowNumber, 18, 1, 4).setValues([saved]);
    sheet.getRange(rowNumber, 22, 1, 3).setValues([[newPhoto, row.point_id || '', row.map_url || '']]);
  });
  return rows.length;
}

function pathRegistryCount_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(PATH_CFG.registry);
  return sheet ? Math.max(sheet.getLastRow() - 1, 0) : 0;
}

function pathWriteSummary_(generatedAt) {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName(PATH_CFG.summary);
  var registry = book.getSheetByName(PATH_CFG.registry);
  if (!sheet || !registry) return;
  var summary = {};
  PATH_DISTRICTS.forEach(function (name) {
    summary[name] = { total: 0, empty: 0, accepted: 0, pending: 0, rework: 0 };
  });
  var last = registry.getLastRow();
  if (last >= 2) {
    registry.getRange(2, 2, last - 1, 11).getValues().forEach(function (row) {
      var item = summary[row[0]];
      if (!item) return;
      item.total += 1;
      if (row[10] === 'Принято') item.accepted += 1;
      else if (row[10] === 'На проверке') item.pending += 1;
      else if (row[10] === 'На доработке') item.rework += 1;
      else item.empty += 1;
    });
  }
  var total = { total: 0, empty: 0, accepted: 0, pending: 0, rework: 0 };
  var values = PATH_DISTRICTS.map(function (name) {
    var item = summary[name];
    total.total += item.total; total.empty += item.empty; total.accepted += item.accepted;
    total.pending += item.pending; total.rework += item.rework;
    return [name, item.total, item.empty, item.accepted, item.pending, item.rework,
      item.total ? item.accepted / item.total : 0];
  });
  values.push(['Итого', total.total, total.empty, total.accepted, total.pending, total.rework,
    total.total ? total.accepted / total.total : 0]);
  sheet.getRange(5, 1, values.length, 7).setValues(values);
  sheet.getRange(5, 7, values.length, 1).setNumberFormat('0.0%');
  sheet.getRange('B2').setValue('обновлено ' + Utilities.formatDate(
    new Date(generatedAt || Date.now()), 'Europe/Moscow', 'dd.MM.yyyy HH:mm'));
}

function pathWriteRework_() {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName(PATH_CFG.rework);
  var registry = book.getSheetByName(PATH_CFG.registry);
  if (!sheet || !registry) return;
  var separator = pathFormulaSeparator_(book);
  var last = registry.getLastRow();
  var list = last >= 2
    ? registry.getRange(2, 1, last - 1, 24).getValues().filter(function (row) { return row[11] === 'На доработке'; })
    : [];
  var sheetLast = sheet.getLastRow();
  if (sheetLast > 1) sheet.getRange(2, 1, sheetLast - 1, 12).clearContent();
  if (!list.length) return;
  var values = list.map(function (row, index) {
    return [
      index + 1, row[1] || '', row[2] || '', row[3] || '', row[4] || '',
      row[5] || '', row[6] || '', row[7] || '', row[8] || '',
      row[15] || '', row[14] ? new Date(row[14]) : '', ''
    ];
  });
  var maps = list.map(function (row) {
    return [row[23]
      ? '=HYPERLINK("' + String(row[23]).replace(/"/g, '""') + '"' + separator + '"На карте")'
      : ''];
  });
  sheet.getRange(2, 1, values.length, 11).setValues(values);
  sheet.getRange(2, 12, maps.length, 1).setFormulas(maps);
}

function pathWriteState_(count, generatedAt) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(PATH_CFG.state);
  if (!sheet) return;
  sheet.getRange('B1').setValue(new Date(generatedAt || Date.now()));
  sheet.getRange('B2').setValue(count);
  sheet.getRange('B3').setValue('');
}

function pathLog_(started, action, added, errors, message) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(PATH_CFG.log);
  if (!sheet) return;
  sheet.appendRow([started, action, added, errors, String(message || '').slice(0, 500)]);
  if (sheet.getLastRow() > 2000) sheet.deleteRows(2, sheet.getLastRow() - 2000);
}

/* ---------- решения ---------- */

function pathPush() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return;
  try { pathPushLocked_(); } finally { lock.releaseLock(); }
}

function pathPushLocked_() {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName(PATH_CFG.registry);
  if (!sheet) throw new Error('Нет листа «' + PATH_CFG.registry + '».');
  var last = sheet.getLastRow();
  if (last < 2) return;
  var rows = sheet.getRange(2, 18, last - 1, 6).getValues();
  var results = rows.map(function (row) { return [row[3] || '']; });
  var batch = [];
  rows.forEach(function (row, index) {
    var decision = String(row[0] || '').trim();
    if (decision === '' || results[index][0] !== '') return;
    var photoId = String(row[4] || '');
    var pointId = String(row[5] || '');
    if (!photoId) { results[index][0] = 'нет активного фото'; return; }
    var action = decision === 'Принять' ? 'accepted'
      : decision === 'Проверено' ? 'verified'
        : decision === 'Вернуть на доработку' ? 'rework' : '';
    if (!action || !pointId) { results[index][0] = 'неизвестное решение'; return; }
    batch.push({
      index: index,
      payload: {
        client_id: pathClientId_(pointId, photoId, action),
        point_id: pointId,
        photo_id: photoId,
        decision: action,
        reason: String(row[1] || ''),
        comment: String(row[2] || '')
      }
    });
  });
  if (!batch.length) { pathWriteResults_(sheet, results); return; }

  var started = new Date();
  for (var offset = 0; offset < batch.length; offset += 100) {
    var chunk = batch.slice(offset, offset + 100);
    try {
      var response = UrlFetchApp.fetch(PATH_CFG.api + '/sheet-decisions', {
        method: 'post',
        contentType: 'application/json',
        headers: { Authorization: 'Bearer ' + pathToken_() },
        payload: JSON.stringify({ decisions: chunk.map(function (item) { return item.payload; }) }),
        muteHttpExceptions: true
      });
      if (response.getResponseCode() !== 200) {
        chunk.forEach(function (item) {
          results[item.index][0] = 'HTTP ' + response.getResponseCode() + ': ' + response.getContentText().slice(0, 120);
        });
        continue;
      }
      var body = JSON.parse(response.getContentText());
      var byClient = {};
      (body.results || []).forEach(function (item) { byClient[item.client_id] = item; });
      chunk.forEach(function (item) {
        var result = byClient[item.payload.client_id];
        if (!result) results[item.index][0] = 'нет ответа';
        else results[item.index][0] = result.applied ? 'OK' : ('ошибка: ' + (result.error || 'не применено'));
      });
    } catch (error) {
      chunk.forEach(function (item) {
        results[item.index][0] = 'ошибка: ' + String(error && error.message || error).slice(0, 120);
      });
    }
  }
  pathWriteResults_(sheet, results);
  pathLog_(started, 'push', batch.length, 0, 'OK');
}

function pathWriteResults_(sheet, results) {
  if (!results.length) return;
  sheet.getRange(2, 21, results.length, 1).setValues(results);
}

function pathClientId_(pointId, photoId, decision) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    pointId + '|' + photoId + '|' + decision, Utilities.Charset.UTF_8);
  return digest.map(function (byte) {
    var value = (byte < 0 ? byte + 256 : byte).toString(16);
    return value.length === 1 ? '0' + value : value;
  }).join('').slice(0, 64);
}

function pathSyncAndPush() {
  try { pathSync(); } catch (error) { return; }
  try { pathPush(); } catch (error) {
    pathLog_(new Date(), 'push', 0, 1, String(error && error.message || error).slice(0, 400));
  }
}

/* ---------- триггеры и оформление ---------- */

function pathInstallTriggers() {
  pathRemoveTriggers();
  ScriptApp.newTrigger('pathSyncAndPush').timeBased().everyMinutes(10).create();
  SpreadsheetApp.getActive().toast('Автообновление включено: каждые 10 минут.', 'Дорожки', 6);
}

function pathRemoveTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'pathSyncAndPush') ScriptApp.deleteTrigger(trigger);
  });
}

function pathStatusColors_(sheet, firstRow, count) {
  var range = sheet.getRange(firstRow, 12, count, 1);
  var rules = sheet.getConditionalFormatRules().filter(function (rule) {
    return !rule.getRanges().some(function (existing) {
      return !(existing.getLastRow() < range.getRow() || existing.getRow() > range.getLastRow()
        || existing.getLastColumn() < range.getColumn() || existing.getColumn() > range.getLastColumn());
    });
  });
  [
    ['Принято', '#E2F4EC', '#0C7A5A'],
    ['На проверке', '#E3EDFD', '#1D4FA7'],
    ['На доработке', '#FDECEF', '#C22545'],
    ['Нет фото', '#EEF1F3', '#63747D']
  ].forEach(function (item) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenTextEqualTo(item[0])
      .setBackground(item[1]).setFontColor(item[2])
      .setRanges([range]).build());
  });
  sheet.setConditionalFormatRules(rules);
}

function pathPercentColors_(sheet, range) {
  var rules = sheet.getConditionalFormatRules().filter(function (rule) {
    return !rule.getRanges().some(function (existing) {
      return !(existing.getLastRow() < range.getRow() || existing.getRow() > range.getLastRow()
        || existing.getLastColumn() < range.getColumn() || existing.getColumn() > range.getLastColumn());
    });
  });
  [
    { min: 0.9995, color: '#00B050' },
    { min: 0.8, color: '#FFF59D' },
    { min: 0.6, color: '#FDD835' },
    { min: 0.4, color: '#FF8A65' },
    { min: 0.2, color: '#E53935' }
  ].forEach(function (band) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThanOrEqualTo(band.min)
      .setBackground(band.color).setRanges([range]).build());
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberLessThan(0.2).setBackground('#B71C1C').setRanges([range]).build());
  sheet.setConditionalFormatRules(rules);
}

/**
 * Красит все колонки «% принято» во всех сводках книги.
 * 100 % — зелёный, 80–60 % — жёлтые оттенки, ниже — красные.
 */
function applyPercentColors() {
  var book = SpreadsheetApp.getActive();
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
    pathPercentColors_(sheet, sheet.getRange(headerRow + 2, column + 1, last - headerRow, 1));
    touched += 1;
  });
  book.toast('Покрашено сводок: ' + touched, 'Проценты', 5);
}
