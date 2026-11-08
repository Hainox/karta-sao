/**
 * Живое обновление таблицы приёмки ДП/СП.
 *
 * Установка (один раз):
 *   1. В таблице: Расширения → Apps Script.
 *   2. Удалить заготовку и вставить этот файл целиком.
 *   3. Проект → Свойства проекта → Свойства скрипта → добавить
 *      SAO_TOKEN = <токен службы>.
 *   4. Сохранить, перезагрузить таблицу, меню «ДП/СП» → «Обновить сейчас».
 *   5. Меню «ДП/СП» → «Включить автообновление».
 *
 * Что обновляется: «Реестр» (все 2 837 площадок), «Свод» (формулы считаются
 * сами), «Журнал» и служебный лист `_state`. «Сверка» пересобирается отдельной
 * командой — в ней живут решения и комментарии проверяющего, их нельзя терять
 * при каждом обновлении.
 */

var CFG = {
  api: 'https://obhod-sao.ru/photo-api/object-photo-points/playgrounds',
  registry: 'Реестр',
  view: 'Сверка',
  log: 'Журнал',
  state: '_state',
  viewRows: 300,
  perDistrict: 20
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('ДП/СП')
    .addItem('Обновить сейчас', 'syncSheet')
    .addItem('Пересобрать «Сверку»', 'refreshView')
    .addSeparator()
    .addItem('Включить автообновление (10 мин)', 'installTriggers')
    .addItem('Выключить автообновление', 'removeTriggers')
    .addToUi();
}

function syncSheet() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return;
  var started = new Date();
  try {
    var data = fetchSheet();
    var written = writeRegistry(data.rows);
    writeState(data.generated_at);
    logRow(started, written, 0, 'OK');
  } catch (error) {
    logRow(started, 0, 1, String(error && error.message || error).slice(0, 400));
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function fetchSheet() {
  var token = PropertiesService.getScriptProperties().getProperty('SAO_TOKEN');
  if (!token) throw new Error('Не задан SAO_TOKEN в свойствах скрипта');
  var response = UrlFetchApp.fetch(CFG.api + '/sheet.json', {
    headers: { Authorization: 'Bearer ' + token },
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

function thumb(kind, token) {
  return CFG.api + '/' + kind + '/' + token;
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
  // Пишем A..N и Q отдельно: O/P («ID задачи» и «Дата задачи» из выгрузки СЖКХ)
  // не трогаем, иначе обновление затрёт данные, которых нет в API.
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
  // Журнал не должен расти бесконечно: держим последние 2 000 запусков.
  if (sheet.getLastRow() > 2000) sheet.deleteRows(2, sheet.getLastRow() - 2000);
}

/**
 * Пересобирает «Сверку»: до 20 принятых площадок с каждого района, сначала те,
 * у кого есть снимок «Север ЖКХ». Решения и комментарии проверяющего
 * переносятся по point_id, а не по номеру строки.
 */
function refreshView() {
  var book = SpreadsheetApp.getActive();
  var registry = book.getSheetByName(CFG.registry);
  var view = book.getSheetByName(CFG.view);
  var last = registry.getLastRow();
  if (last < 2) return;

  var data = registry.getRange(2, 1, last - 1, 17).getValues();
  var accepted = data.filter(function (row) { return row[7] === 'Принято' && row[12]; });
  accepted.sort(function (left, right) {
    var bySever = (left[16] ? 0 : 1) - (right[16] ? 0 : 1);
    if (bySever) return bySever;
    return String(left[4]).localeCompare(String(right[4]), 'ru');
  });

  var byDistrict = {};
  accepted.forEach(function (row) {
    var key = row[2];
    (byDistrict[key] = byDistrict[key] || []).push(row);
  });
  var slice = [];
  for (var offset = 0; offset < CFG.perDistrict && slice.length < CFG.viewRows; offset += 1) {
    Object.keys(byDistrict).sort().forEach(function (district) {
      if (slice.length < CFG.viewRows && byDistrict[district][offset]) {
        slice.push(byDistrict[district][offset]);
      }
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
      '=IMAGE("' + row[12] + '",4,160,120)'
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

function installTriggers() {
  removeTriggers();
  ScriptApp.newTrigger('syncSheet').timeBased().everyMinutes(10).create();
  // «Сверку» пересобираем раз в сутки: она держит решения проверяющего,
  // и двигать строки под ним каждые 10 минут нельзя.
  ScriptApp.newTrigger('refreshView').timeBased().atHour(7).everyDays(1).create();
  SpreadsheetApp.getActive().toast('Автообновление включено: данные каждые 10 минут, «Сверка» — в 07:00', 'ДП/СП', 5);
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncSheet' || trigger.getHandlerFunction() === 'refreshView') {
      ScriptApp.deleteTrigger(trigger);
    }
  });
}
