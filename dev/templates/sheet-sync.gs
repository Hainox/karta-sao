/**
 * Живое обновление таблицы приёмки ДП/СП и возврат решений в кабинет.
 *
 * Установка (один раз):
 *   1. В таблице: Расширения → Apps Script.
 *   2. Вставить этот файл целиком.
 *   3. Слева внизу шестерёнка «Настройки проекта» → «Свойства скрипта» →
 *      добавить SAO_TOKEN = <токен службы>.
 *   4. Сохранить, перезагрузить таблицу, меню «ДП/СП» → «Обновить сейчас».
 *   5. Меню «ДП/СП» → «Включить автообновление».
 *
 * Что делает:
 *   • каждые 10 минут обновляет «Реестр», «Свод» и «На доработке»;
 *   • каждые 10 минут отправляет решения из «Сверки» в кабинет;
 *   • «Сверку» пересобирает в 07:00 и по команде меню, сохраняя решения;
 *   • фильтры B1:B2 на «Сверке» пересобирают вид при изменении.
 */

var CFG = {
  api: 'https://obhod-sao.ru/photo-api/object-photo-points/playgrounds',
  registry: 'Реестр',
  view: 'Сверка',
  rework: 'На доработке',
  log: 'Журнал',
  state: '_state',
  viewRows: 300,
  perDistrict: 20
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('ДП/СП')
    .addItem('Обновить сейчас', 'syncSheet')
    .addItem('Пересобрать «Сверку»', 'refreshView')
    .addItem('Отправить решения', 'pushDecisions')
    .addSeparator()
    .addItem('Включить автообновление (10 мин)', 'installTriggers')
    .addItem('Выключить автообновление', 'removeTriggers')
    .addToUi();
}

// Фильтры «Сверки»: смена района или статуса сразу пересобирает вид.
function onEdit(event) {
  var range = event && event.range;
  if (!range) return;
  if (range.getSheet().getName() !== CFG.view) return;
  if (range.getRow() > 3 || range.getColumn() > 3) return;
  refreshView();
}

function syncSheet() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return;
  var started = new Date();
  try {
    var data = fetchSheet();
    var written = writeRegistry(data.rows);
    writeRework(data.rows);
    writeState(data.generated_at);
    logRow(started, written, 0, 'OK');
  } catch (error) {
    logRow(started, 0, 1, String(error && error.message || error).slice(0, 400));
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function token() {
  var value = PropertiesService.getScriptProperties().getProperty('SAO_TOKEN');
  if (!value) throw new Error('Не задан SAO_TOKEN в свойствах скрипта');
  return value;
}

function fetchSheet() {
  var response = UrlFetchApp.fetch(CFG.api + '/sheet.json', {
    headers: { Authorization: 'Bearer ' + token() },
    muteHttpExceptions: true
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('HTTP ' + response.getResponseCode() + ': ' +
      response.getContentText().slice(0, 200));
  }
  return JSON.parse(response.getContentText());
}

function stateLabel(row) {
  if (row.photo_state === 'accepted') return 'Принято';
  if (row.photo_state === 'pending') return 'На проверке';
  if (row.photo_state === 'empty' && row.rejected_at) return 'На доработке';
  return 'Нет фото';
}

function thumb(kind, tokenValue) {
  return CFG.api + '/' + kind + '/' + tokenValue;
}

function writeRegistry(rows) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.registry);
  var values = rows.map(function (row) {
    return [
      row.point_id,
      String(row.source_id || ''),
      row.district || '',
      row.kind === 'dp' ? 'ДП' : 'СП',
      row.address || '',
      row.latitude || '',
      row.longitude || '',
      stateLabel(row),
      row.uploaded_at ? new Date(row.uploaded_at) : '',
      row.reviewed_at ? new Date(row.reviewed_at) : '',
      row.review_comment || '',
      row.photo_id || '',
      row.photo_token ? thumb('photo-thumb', row.photo_token) : '',
      row.sever_token ? 'есть' : 'нет',
      '',
      '',
      row.sever_token ? thumb('sever-thumb', row.sever_token) : ''
    ];
  });
  if (!values.length) return 0;
  // Пишем A..N и Q отдельно: O/P («ID задачи» и «Дата задачи» из выгрузки
  // Север ЖКХ) не трогаем, иначе обновление затрёт данные, которых нет в API.
  var base = values.map(function (row) { return row.slice(0, 14); });
  var sever = values.map(function (row) { return [row[16]]; });
  sheet.getRange(2, 1, base.length, 14).setValues(base);
  sheet.getRange(2, 17, sever.length, 1).setValues(sever);
  var extra = sheet.getLastRow() - values.length - 1;
  if (extra > 0) {
    sheet.getRange(values.length + 2, 1, extra, 14).clearContent();
    sheet.getRange(values.length + 2, 17, extra, 1).clearContent();
  }
  return values.length;
}

function writeRework(rows) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.rework);
  if (!sheet) return;
  var list = rows.filter(function (row) { return stateLabel(row) === 'На доработке'; });
  var values = list.map(function (row, index) {
    return [
      index + 1, row.district || '', row.address || '', String(row.source_id || ''),
      'На доработке', row.rejected_comment || '', '—', '', '', '',
      row.rejected_at ? new Date(row.rejected_at) : '', ''
    ];
  });
  var clear = Math.max(sheet.getLastRow() - 4, 1);
  sheet.getRange(5, 1, clear, 12).clearContent();
  if (values.length) sheet.getRange(5, 1, values.length, 12).setValues(values);
}

function writeState(generatedAt) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.state);
  if (!sheet) return;
  sheet.getRange('B3').setValue('обновлено ' +
    Utilities.formatDate(new Date(generatedAt || Date.now()), Session.getScriptTimeZone(), 'dd.MM.yyyy HH:mm'));
  sheet.getRange('B4').setValue(new Date());
}

function logRow(started, added, errors, message) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.log);
  if (!sheet) return;
  sheet.appendRow([started, 'syncSheet', added, 0, errors, errors ? 'ERROR' : 'OK', message]);
  if (sheet.getLastRow() > 2000) sheet.deleteRows(2, sheet.getLastRow() - 2000);
}

/**
 * Пересобирает «Сверку» по фильтрам B1 (район) и B2 (статус).
 * Решения и комментарии проверяющего переносятся по point_id.
 */
function refreshView() {
  var book = SpreadsheetApp.getActive();
  var registry = book.getSheetByName(CFG.registry);
  var view = book.getSheetByName(CFG.view);
  var last = registry.getLastRow();
  if (last < 2) return;

  var district = String(view.getRange('B1').getValue() || '');
  var status = String(view.getRange('B2').getValue() || 'Все');
  var wanted = (!status || status === 'Все') ? 'Принято' : status;

  var data = registry.getRange(2, 1, last - 1, 17).getValues();
  var picked = data.filter(function (row) {
    if (row[7] !== wanted) return false;
    if (wanted === 'Принято' && !row[12]) return false;
    if (district && district !== 'Все районы' && row[2] !== district) return false;
    return true;
  });
  picked.sort(function (left, right) {
    var bySever = (left[16] ? 0 : 1) - (right[16] ? 0 : 1);
    if (bySever) return bySever;
    return String(left[4]).localeCompare(String(right[4]), 'ru');
  });

  var byDistrict = {};
  picked.forEach(function (row) {
    var key = row[2];
    (byDistrict[key] = byDistrict[key] || []).push(row);
  });
  var slice = [];
  for (var offset = 0; offset < CFG.perDistrict && slice.length < CFG.viewRows; offset += 1) {
    Object.keys(byDistrict).sort().forEach(function (key) {
      if (slice.length < CFG.viewRows && byDistrict[key][offset]) slice.push(byDistrict[key][offset]);
    });
  }

  var old = view.getRange(8, 1, Math.max(view.getLastRow() - 7, 1), 16).getValues();
  var decisions = {};
  old.forEach(function (row) {
    if (row[14]) decisions[row[14]] = { decision: row[9], reason: row[10], comment: row[11] };
  });

  var values = [];
  var photos = [];
  slice.forEach(function (row, index) {
    var saved = decisions[row[0]] || { decision: '—', reason: '', comment: '' };
    values.push([
      index + 1, '', row[2], row[4],
      row[3] === 'ДП' ? 'Детская площадка' : 'Спортивная площадка',
      row[1], '', '', row[7], saved.decision, saved.reason, saved.comment
    ]);
    photos.push([
      row[16] ? '=IMAGE("' + row[16] + '",4,160,120)' : '',
      row[12] ? '=IMAGE("' + row[12] + '",4,160,120)' : ''
    ]);
  });

  var height = Math.max(values.length, CFG.viewRows);
  view.getRange(8, 1, height, 12).clearContent();
  view.getRange(8, 15, height, 2).clearContent();
  if (values.length) {
    view.getRange(8, 1, values.length, 12).setValues(values);
    view.getRange(8, 7, values.length, 2).setFormulas(photos);
    view.getRange(8, 15, values.length, 2).setValues(slice.map(function (row) {
      return [row[0], row[11]];
    }));
  }
}

/**
 * Отправляет решения из «Сверки» в кабинет. «Вернуть на доработку» реально
 * отзывает принятый снимок; повторный прогон не отзывает его второй раз.
 */
function pushDecisions() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.view);
  var last = sheet.getLastRow();
  if (last < 8) return;
  var rows = sheet.getRange(8, 1, last - 7, 17).getValues();
  var batch = [];
  rows.forEach(function (row, index) {
    var decision = row[9];
    if (!decision || decision === '—') return;
    if (row[16]) return;               // Q — уже отправлено
    if (!row[14] || !row[15]) return;  // O — point_id, P — photo_id
    batch.push({
      client_id: clientIdFor(row[14], row[15], decision),
      point_id: row[14],
      photo_id: row[15],
      decision: decision === 'Принято (сверка с С-ЖКХ)' ? 'accepted_crosscheck' : 'rework',
      reason: row[10] || '',
      comment: row[11] || '',
      reviewed_by: Session.getActiveUser().getEmail() || 'sheet',
      reviewed_at: new Date().toISOString(),
      _row: index + 8
    });
  });
  for (var offset = 0; offset < batch.length; offset += 100) {
    var chunk = batch.slice(offset, offset + 100);
    var payload = chunk.map(function (item) {
      var copy = {};
      for (var key in item) if (key !== '_row') copy[key] = item[key];
      return copy;
    });
    var response = UrlFetchApp.fetch(CFG.api + '/sheet-decisions', {
      method: 'post',
      contentType: 'application/json',
      headers: { Authorization: 'Bearer ' + token() },
      payload: JSON.stringify({ decisions: payload }),
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      throw new Error('HTTP ' + response.getResponseCode() + ': ' +
        response.getContentText().slice(0, 200));
    }
    var body = JSON.parse(response.getContentText());
    (body.results || []).forEach(function (result, index) {
      if (result.applied) sheet.getRange(chunk[index]._row, 17).setValue(new Date());
    });
  }
}

// Детерминированный id: повторный прогон не создаёт второе решение.
function clientIdFor(pointId, photoId, decision) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    pointId + '|' + photoId + '|' + decision);
  var hex = digest.map(function (byte) {
    var value = (byte & 0xff).toString(16);
    return value.length === 1 ? '0' + value : value;
  }).join('');
  return hex.slice(0, 32);
}

function installTriggers() {
  removeTriggers();
  ScriptApp.newTrigger('syncSheet').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('pushDecisions').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('refreshView').timeBased().atHour(7).everyDays(1).create();
  SpreadsheetApp.getActive().toast('Автообновление включено: данные и решения каждые 10 минут, «Сверка» — в 07:00', 'ДП/СП', 5);
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    var handler = trigger.getHandlerFunction();
    if (handler === 'syncSheet' || handler === 'pushDecisions' || handler === 'refreshView') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}
