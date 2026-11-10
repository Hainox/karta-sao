/**
 * Отдельная книга проверки оцифровки тротуаров: ОДХ и дворы.
 *
 * Это не вкладки книги ДП/СП. Скрипт можно добавить отдельным файлом в уже
 * существующий проект Apps Script книги ДП/СП: он не определяет onOpen и не
 * трогает её функции, а работает с новой книгой через openById. Служебный
 * доступ хранится только в свойствах скрипта: SAO_LOGIN и SAO_PASSWORD (вход
 * с автообновлением сессии) или готовый SAO_TOKEN.
 *
 * Установка:
 *   1. Создать новую Google-таблицу (пустую).
 *   2. Вставить её ID из адресной строки в SIDEWALK_CFG.bookId ниже.
 *   3. В «Настройках проекта» → «Свойства скрипта» задать SAO_LOGIN и
 *      SAO_PASSWORD служебной учётной записи (или готовый SAO_TOKEN).
 *   4. В редакторе Apps Script выполнить sidewalkSetup — создать листы,
 *      шапки, проверку ввода, фильтр и оформление.
 *   5. Выполнить sidewalkSync — заполнить оба листа.
 *   6. При желании добавить в существующий onOpen вызов sidewalkAddMenu().
 *   7. Выполнить sidewalkInstallTriggers — обновление и отправка каждые 10 мин.
 *
 * Что делает:
 *   • «Тротуары ОДХ» — одна строка на кадр фотослота, включая кадры без фото
 *     и пометку «Нет тротуара»;
 *   • «Тротуары дворы» — одна строка на действующую точку съёмки;
 *   • решения «Проверено» и «Вернуть на доработку» уходят в кабинет;
 *   • решения и отметки отправки хранятся в скрытом листе _state по ключу
 *     «набор + точка/слот + photo_id», поэтому переживают обновление,
 *     фильтрацию и пересъёмку: старый снимок не получает чужое решение;
 *   • ошибка отправки видна в колонке «Результат отправки» и не теряется;
 *   • повторная отправка идемпотентна по client_id.
 */

var SIDEWALK_CFG = {
  // ID новой книги. Обязателен: скрипт никогда не пишет в активную книгу
  // ДП/СП по ошибке.
  bookId: '',
  api: 'https://obhod-sao.ru/photo-api/object-photo-points/sidewalk-test/sheet',
  authApi: 'https://obhod-sao.ru/photo-api',
  mapBase: 'https://hainox.github.io/karta-sao/districts/',
  headerRow: 5,
  firstRow: 6,
  maxRows: 30000,
  chunk: 100
};

var SIDEWALK_SETS = {
  odh: {
    title: 'Тротуары ОДХ · проверка оцифровки',
    sheet: 'Тротуары ОДХ',
    tabColor: '#176bb0',
    headers: ['№', 'Район', 'Адрес / название ОДХ', 'Номер точки', 'Кадр', 'Фото',
      'Статус', 'Решение', 'Причина возврата', 'Комментарий', 'На карте',
      'Результат отправки', 'Нет тротуара', 'point_id', 'photo_id', 'set',
      'district_raw', 'photo_url', 'key', 'preview_key'],
    widths: [42, 130, 260, 120, 55, 170, 105, 145, 210, 210, 90, 185, 90, 110, 36, 40, 130, 280, 280, 280],
    visible: 13,
    photo: 6,
    status: 7,
    decision: 8,
    reason: 9,
    comment: 10,
    map: 11,
    result: 12,
    key: 19,
    previewKey: 20
  },
  yards: {
    title: 'Тротуары дворы · проверка оцифровки',
    sheet: 'Тротуары дворы',
    tabColor: '#f28c18',
    headers: ['№', 'Район', 'Адрес', 'Номер точки', 'Место', 'Сторона', 'Фото',
      'Статус', 'Решение', 'Причина возврата', 'Комментарий', 'На карте',
      'Результат отправки', 'point_id', 'photo_id', 'set', 'district_raw',
      'photo_url', 'key', 'preview_key'],
    widths: [42, 130, 260, 110, 110, 90, 170, 105, 145, 210, 210, 90, 185, 110, 36, 40, 130, 280, 280, 280],
    visible: 13,
    photo: 7,
    status: 8,
    decision: 9,
    reason: 10,
    comment: 11,
    map: 12,
    result: 13,
    key: 19,
    previewKey: 20
  }
};

// Слаги страниц районов: по ним строится ссылка «На карте». «АВД САО» в
// выгрузке — подпись, а district_raw хранит настоящий район.
var SIDEWALK_SLUGS = {
  'Аэропорт': 'aeroport',
  'Беговой': 'begovoy',
  'Бескудниковский': 'beskudnikovskiy',
  'Войковский': 'voykovskiy',
  'Восточное Дегунино': 'vostochnoe-degunino',
  'Головинский': 'golovinskiy',
  'Дмитровский': 'dmitrovskiy',
  'Западное Дегунино': 'zapadnoe-degunino',
  'Коптево': 'koptevo',
  'Левобережный': 'levoberezhnyy',
  'Молжаниновский': 'molzhaninovskiy',
  'Савеловский': 'savelovskiy',
  'Сокол': 'sokol',
  'Тимирязевский': 'timiryazevskiy',
  'Ховрино': 'hovrino',
  'Хорошевский': 'horoshevskiy'
};

var SIDEWALK_DECISIONS = ['—', 'Проверено', 'Вернуть на доработку'];
var SIDEWALK_STATE_HEADERS = ['key', 'set', 'point_id', 'photo_id', 'decision', 'reason',
  'comment', 'sent_decision', 'sent_at', 'result', 'updated_at'];
var SIDEWALK_LOG_HEADERS = ['Время', 'Действие', 'Набор', 'Строк', 'Ошибок', 'Сообщение'];

function sidewalkBook_() {
  var id = String(SIDEWALK_CFG.bookId || '').replace(/\s+/g, '');
  if (!id) throw new Error('В SIDEWALK_CFG.bookId укажите ID новой книги тротуаров.');
  return SpreadsheetApp.openById(id);
}

function sidewalkToken_() {
  var props = PropertiesService.getScriptProperties();
  var value = props.getProperty('SAO_TOKEN');
  var expires = Number(props.getProperty('SAO_TOKEN_EXPIRES') || 0);
  // Срок задаётся только для токена, полученного входом. Токен, вписанный
  // вручную, используем, пока сервер его принимает.
  if (value && (!expires || expires > Date.now() + 60000)) return value;
  return sidewalkLogin_();
}

/** Сбрасывает кэш токена: следующий запрос войдёт заново по SAO_LOGIN. */
function sidewalkForgetToken_() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('SAO_TOKEN');
  props.deleteProperty('SAO_TOKEN_EXPIRES');
}

/**
 * Вход служебной учёткой. Пароль хранится только в свойствах скрипта, не в
 * листах и не в коде. Сессия живёт 8 часов; кэшируем на 7, чтобы обновить
 * заранее. Логин и пароль не попадают в сообщения об ошибках.
 */
function sidewalkLogin_() {
  var props = PropertiesService.getScriptProperties();
  var login = String(props.getProperty('SAO_LOGIN') || '').trim();
  var password = String(props.getProperty('SAO_PASSWORD') || '').trim();
  if (!login || !password) {
    throw new Error('Нет действующего SAO_TOKEN. Задайте SAO_LOGIN и SAO_PASSWORD '
      + '(служебная учётка) в свойствах скрипта.');
  }
  var response = UrlFetchApp.fetch(SIDEWALK_CFG.authApi + '/auth/login', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ login: login, password: password }),
    muteHttpExceptions: true
  });
  var code = response.getResponseCode();
  if (code !== 200) {
    throw new Error('Вход не выполнен: HTTP ' + code + ' ' + response.getContentText().slice(0, 200));
  }
  var body;
  try { body = JSON.parse(response.getContentText()); } catch (_) { body = {}; }
  if (!body.token) throw new Error('Вход не выполнен: служба не вернула токен.');
  props.setProperty('SAO_TOKEN', body.token);
  props.setProperty('SAO_TOKEN_EXPIRES', String(Date.now() + 7 * 60 * 60 * 1000));
  return body.token;
}

/**
 * Запрос с Bearer-токеном. На 401 один раз сбрасывает кэш и входит заново:
 * сессия могла истечь между проверкой срока и запросом.
 */
function sidewalkAuthorizedFetch_(url, options) {
  var opts = options || {};
  opts.headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + sidewalkToken_() });
  opts.muteHttpExceptions = true;
  var response = UrlFetchApp.fetch(url, opts);
  if (response.getResponseCode() !== 401) return response;
  sidewalkForgetToken_();
  opts.headers.Authorization = 'Bearer ' + sidewalkToken_();
  return UrlFetchApp.fetch(url, opts);
}

function sidewalkNotify_(message) {
  try {
    var active = SpreadsheetApp.getActive();
    if (active) active.toast(String(message || ''), 'Тротуары', 5);
  } catch (_) { /* запуск из редактора без активной книги */ }
  Logger.log(message);
}

/** Ошибка верхнего уровня видна прямо в книге, а не только в _log. */
function sidewalkShowError_(book, message) {
  if (!book) return;
  var text = 'ОШИБКА: ' + String(message || '').slice(0, 300);
  ['odh', 'yards'].forEach(function (setName) {
    var sheet = book.getSheetByName(SIDEWALK_SETS[setName].sheet);
    if (!sheet) return;
    sheet.getRange(2, 1).setValue(text).setFontColor('#cc0000');
  });
}

/** Создаёт и оформляет оба рабочих листа. Повторный запуск безопасен. */
function sidewalkSetup() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Скрипт уже выполняется, повторите позже.');
  try {
    var book = sidewalkBook_();
    book.setSpreadsheetTimeZone('Europe/Moscow');
    sidewalkEnsureDataSheet_(book, SIDEWALK_SETS.odh, 0);
    sidewalkEnsureDataSheet_(book, SIDEWALK_SETS.yards, 1);
    sidewalkEnsureState_(book);
    sidewalkEnsureLog_(book);
    SpreadsheetApp.flush();
    sidewalkNotify_('Книга тротуаров подготовлена. Запустите «Обновить книгу».');
  } finally {
    lock.releaseLock();
  }
}

function sidewalkEnsureDataSheet_(book, config, index) {
  var sheet = book.getSheetByName(config.sheet);
  if (!sheet) {
    var sheets = book.getSheets();
    if (index === 0 && sheets.length === 1 && sheets[0].getLastRow() === 0
        && sheets[0].getName() !== SIDEWALK_SETS.yards.sheet) {
      sheet = sheets[0].setName(config.sheet);
    } else {
      sheet = book.insertSheet(config.sheet, index);
    }
  }
  sidewalkFormatDataSheet_(sheet, config);
  return sheet;
}

function sidewalkFormatDataSheet_(sheet, config) {
  var maxRows = Math.max(sheet.getMaxRows(), SIDEWALK_CFG.maxRows);
  if (sheet.getMaxRows() < maxRows) sheet.insertRowsAfter(sheet.getMaxRows(), maxRows - sheet.getMaxRows());

  // Закреплённые столбцы нельзя сочетать с объединением, которое пересекает
  // их границу. Снимаем закрепление до объединения шапки; ниже закрепляем
  // только строки.
  sheet.setFrozenColumns(0);

  var filter = sheet.getFilter();
  if (filter) filter.remove();
  sheet.clearConditionalFormatRules();

  var title = sheet.getRange(1, 1, 1, config.visible);
  if (title.isPartOfMerge()) title.breakApart();
  title.merge();
  title.setValue(config.title).setFontSize(15).setFontWeight('bold')
    .setFontColor('#17365d').setVerticalAlignment('middle').setHorizontalAlignment('left');
  sheet.setRowHeight(1, 30);

  var summary = sheet.getRange(2, 1, 1, config.visible);
  if (summary.isPartOfMerge()) summary.breakApart();
  summary.merge();
  summary.setValue('Данные ещё не загружены. Запустите «Обновить книгу».')
    .setFontSize(10).setFontColor('#555555').setVerticalAlignment('middle');
  sheet.setRowHeight(2, 22);

  var hint = sheet.getRange(3, 1, 1, config.visible);
  if (hint.isPartOfMerge()) hint.breakApart();
  hint.merge();
  hint.setValue('«Проверено» фиксируется в журнале. «Вернуть на доработку» отзывает только принятый снимок '
    + 'и освобождает слот; причина видна району в кабинете. Решения отправляются каждые 10 минут.')
    .setFontSize(9).setFontColor('#666666').setWrap(true).setVerticalAlignment('middle');
  sheet.setRowHeight(3, 34);
  sheet.setRowHeight(4, 8);

  var header = sheet.getRange(SIDEWALK_CFG.headerRow, 1, 1, 20);
  header.setValues([config.headers])
    .setFontWeight('bold').setFontColor('#ffffff').setBackground('#1f4e79')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sheet.setRowHeight(SIDEWALK_CFG.headerRow, 46);

  for (var column = 0; column < config.widths.length; column += 1) {
    sheet.setColumnWidth(column + 1, config.widths[column]);
  }

  var bodyRows = maxRows - SIDEWALK_CFG.firstRow + 1;
  var body = sheet.getRange(SIDEWALK_CFG.firstRow, 1, bodyRows, 20);
  body.setFontSize(10).setVerticalAlignment('middle');
  sheet.getRange(SIDEWALK_CFG.firstRow, 3, bodyRows, 1).setWrap(true);
  sheet.getRange(SIDEWALK_CFG.firstRow, config.reason, bodyRows, 2).setWrap(true);
  sheet.getRange(SIDEWALK_CFG.firstRow, config.result, bodyRows, 1).setWrap(true);

  var decisionRange = sheet.getRange(SIDEWALK_CFG.firstRow, config.decision, bodyRows, 1);
  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(SIDEWALK_DECISIONS, true)
    .setAllowInvalid(false)
    .setHelpText('«Проверено» — отметить принятый снимок; «Вернуть на доработку» — вернуть его району с причиной.')
    .build();
  decisionRange.setDataValidation(rule);

  sheet.hideColumns(14, 7);
  sheet.setFrozenRows(SIDEWALK_CFG.headerRow);
  sheet.setTabColor(config.tabColor);

  sidewalkSetConditionalRules_(sheet, config, maxRows);
  // Фильтр покрывает и скрытые ключи N:T: сортировка по видимой колонке
  // должна переносить key/photo_id вместе со строкой, иначе решение уедет
  // к чужому снимку.
  sheet.getRange(SIDEWALK_CFG.headerRow, 1, maxRows - SIDEWALK_CFG.headerRow + 1, 20).createFilter();
}

function sidewalkSetConditionalRules_(sheet, config, maxRows) {
  var rows = maxRows - SIDEWALK_CFG.firstRow + 1;
  var whole = sheet.getRange(SIDEWALK_CFG.firstRow, 1, rows, config.visible);
  var status = '$' + sidewalkColumn_(config.status) + SIDEWALK_CFG.firstRow;
  var decision = '$' + sidewalkColumn_(config.decision) + SIDEWALK_CFG.firstRow;
  var result = '$' + sidewalkColumn_(config.result) + SIDEWALK_CFG.firstRow;
  var rules = [];

  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=' + status + '="Принято"')
    .setBackground('#d9ead3').setRanges([whole]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=' + status + '="На проверке"')
    .setBackground('#fff2cc').setRanges([whole]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=' + status + '="На доработке"')
    .setBackground('#f4cccc').setRanges([whole]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=' + status + '="Нет фото"')
    .setBackground('#efefef').setRanges([whole]).build());

  var decisionRange = sheet.getRange(SIDEWALK_CFG.firstRow, config.decision, rows, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=' + decision + '="Проверено"')
    .setBackground('#b6d7a8').setRanges([decisionRange]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=' + decision + '="Вернуть на доработку"')
    .setBackground('#ea9999').setRanges([decisionRange]).build());

  var resultRange = sheet.getRange(SIDEWALK_CFG.firstRow, config.result, rows, 1);
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=LEFT(' + result + ',13)="Не отправлено"')
    .setFontColor('#cc0000').setRanges([resultRange]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=LEFT(' + result + ',4)="Ждёт"')
    .setFontColor('#b45f06').setRanges([resultRange]).build());

  if (config === SIDEWALK_SETS.odh) {
    var flag = sheet.getRange(SIDEWALK_CFG.firstRow, 13, rows, 1);
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied('=$M' + SIDEWALK_CFG.firstRow + '="да"')
      .setBackground('#cfe2f3').setFontColor('#0b5394').setRanges([flag]).build());
  }
  sheet.setConditionalFormatRules(rules);
}

function sidewalkEnsureState_(book) {
  var sheet = book.getSheetByName('_state');
  if (!sheet) sheet = book.insertSheet('_state');
  sheet.hideSheet();
  sheet.getRange(1, 1, 1, SIDEWALK_STATE_HEADERS.length).setValues([SIDEWALK_STATE_HEADERS])
    .setFontWeight('bold').setBackground('#efefef');
  sheet.setFrozenRows(1);
  sheet.setColumnWidth(1, 280);
  sheet.setColumnWidth(2, 60);
  sheet.setColumnWidth(3, 120);
  sheet.setColumnWidth(4, 280);
  sheet.setColumnWidth(5, 150);
  sheet.setColumnWidth(6, 240);
  sheet.setColumnWidth(7, 240);
  sheet.setColumnWidth(8, 150);
  sheet.setColumnWidth(9, 150);
  sheet.setColumnWidth(10, 260);
  sheet.setColumnWidth(11, 150);
  sheet.getRange('I:I').setNumberFormat('dd.MM.yyyy HH:mm:ss');
  sheet.getRange('K:K').setNumberFormat('dd.MM.yyyy HH:mm:ss');
}

function sidewalkEnsureLog_(book) {
  var sheet = book.getSheetByName('_log');
  if (!sheet) sheet = book.insertSheet('_log');
  sheet.hideSheet();
  sheet.getRange(1, 1, 1, SIDEWALK_LOG_HEADERS.length).setValues([SIDEWALK_LOG_HEADERS])
    .setFontWeight('bold').setBackground('#efefef');
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('dd.MM.yyyy HH:mm:ss');
  sheet.setColumnWidth(1, 145);
  sheet.setColumnWidth(2, 70);
  sheet.setColumnWidth(3, 55);
  sheet.setColumnWidth(4, 55);
  sheet.setColumnWidth(5, 60);
  sheet.setColumnWidth(6, 420);
}

/** Обновляет оба листа, сохраняя решения и отметки отправки. */
function sidewalkSync() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  var started = new Date();
  var total = 0;
  var book;
  try {
    book = sidewalkBook_();
    var drafts = sidewalkReadDrafts_(book);
    sidewalkCapture_(book, drafts);
    sidewalkSaveDrafts_(book, drafts);
    var odh = sidewalkFetch_('odh');
    var yards = sidewalkFetch_('yards');
    sidewalkWriteSet_(book, 'odh', odh.rows || [], drafts);
    sidewalkWriteSet_(book, 'yards', yards.rows || [], drafts);
    total = (odh.rows || []).length + (yards.rows || []).length;
    sidewalkLog_(book, started, 'sync', total, 0, 'OK');
  } catch (error) {
    sidewalkLog_(book, started, 'sync', total, 1, String(error && error.message || error).slice(0, 400));
    sidewalkShowError_(book, String(error && error.message || error));
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function sidewalkFetch_(setName) {
  var response = sidewalkAuthorizedFetch_(SIDEWALK_CFG.api + '/sheet.json?set=' + encodeURIComponent(setName), {});
  var code = response.getResponseCode();
  if (code !== 200) throw new Error('HTTP ' + code + ': ' + response.getContentText().slice(0, 300));
  return JSON.parse(response.getContentText());
}

/** Читает правки из листов и переносит их в _state до перезаписи данных. */
function sidewalkCapture_(book, drafts) {
  ['odh', 'yards'].forEach(function (setName) {
    var config = SIDEWALK_SETS[setName];
    var sheet = book.getSheetByName(config.sheet);
    if (!sheet) return;
    var last = sheet.getLastRow();
    if (last < SIDEWALK_CFG.firstRow) return;
    var values = sheet.getRange(SIDEWALK_CFG.firstRow, 1, last - SIDEWALK_CFG.firstRow + 1, 20).getValues();
    values.forEach(function (row) {
      var key = String(row[config.key - 1] || '');
      var photoId = String(row[14] || '');
      if (!key || !photoId) return;
      var raw = String(row[config.decision - 1] || '').trim();
      var decision = raw === '—' ? '' : raw;
      var reason = String(row[config.reason - 1] || '').trim();
      var comment = String(row[config.comment - 1] || '').trim();
      var draft = drafts[key];
      if (!draft) {
        if (!decision) return;
        draft = { key: key, set_name: setName, point_id: String(row[13] || ''), photo_id: photoId,
          decision: '', reason: '', comment: '', sent_decision: '', sent_at: '', result: '', updated_at: '' };
        drafts[key] = draft;
      }
      if (draft.decision === decision && draft.reason === reason && draft.comment === comment) return;
      var changedAfterSend = draft.sent_decision && (draft.decision !== decision
        || draft.reason !== reason || draft.comment !== comment);
      draft.decision = decision;
      draft.reason = reason;
      draft.comment = comment;
      draft.updated_at = new Date().toISOString();
      if (changedAfterSend || !decision) {
        draft.sent_decision = '';
        draft.result = '';
      }
    });
  });
}

function sidewalkReadDrafts_(book) {
  var sheet = book.getSheetByName('_state');
  var map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, SIDEWALK_STATE_HEADERS.length).getValues();
  values.forEach(function (row) {
    var key = String(row[0] || '');
    if (!key) return;
    map[key] = {
      key: key,
      set_name: String(row[1] || ''),
      point_id: String(row[2] || ''),
      photo_id: String(row[3] || ''),
      decision: String(row[4] || ''),
      reason: String(row[5] || ''),
      comment: String(row[6] || ''),
      sent_decision: String(row[7] || ''),
      sent_at: row[8] ? sidewalkIso_(row[8]) : '',
      result: String(row[9] || ''),
      updated_at: row[10] ? sidewalkIso_(row[10]) : ''
    };
  });
  return map;
}

/**
 * Перезаписывает _state. Вынесено отдельно, потому что и sync, и push
 * сохраняют журнал после работы.
 */
function sidewalkSaveDrafts_(book, drafts) {
  var sheet = book.getSheetByName('_state');
  if (!sheet) return;
  var keys = Object.keys(drafts).sort();
  var values = keys.map(function (key) {
    var draft = drafts[key];
    return [draft.key, draft.set_name, draft.point_id, draft.photo_id, draft.decision,
      draft.reason, draft.comment, draft.sent_decision,
      draft.sent_at ? new Date(draft.sent_at) : '', draft.result,
      draft.updated_at ? new Date(draft.updated_at) : ''];
  });
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, SIDEWALK_STATE_HEADERS.length).clearContent();
  if (values.length) {
    sidewalkEnsureRows_(sheet, values.length + 1);
    sheet.getRange(2, 1, values.length, SIDEWALK_STATE_HEADERS.length).setValues(values);
  }
}

function sidewalkEnsureRows_(sheet, needed) {
  if (sheet.getMaxRows() < needed) sheet.insertRowsAfter(sheet.getMaxRows(), needed - sheet.getMaxRows());
}

function sidewalkWriteSet_(book, setName, rows, drafts) {
  var config = SIDEWALK_SETS[setName];
  var sheet = book.getSheetByName(config.sheet);
  if (!sheet) throw new Error('Нет листа «' + config.sheet + '». Сначала выполните sidewalkSetup.');

  var last = sheet.getLastRow();
  var clearRows = Math.max(last - SIDEWALK_CFG.firstRow + 1, rows.length, 1);
  sidewalkEnsureRows_(sheet, SIDEWALK_CFG.firstRow + Math.max(rows.length, clearRows) - 1);
  sheet.getRange(SIDEWALK_CFG.firstRow, 1, clearRows, 20).clearContent();
  if (!rows.length) {
    sheet.getRange(2, 1).setValue('Обновлено ' + sidewalkMoscow_(new Date()) + ' МСК · строк: 0')
      .setFontColor('#555555');
    return;
  }

  var values = [];
  var photoFormulas = [];
  var mapFormulas = [];
  var counts = { total: rows.length, photo: 0, accepted: 0, pending: 0, rework: 0, empty: 0, noSidewalk: 0, pendingSend: 0 };

  rows.forEach(function (row, index) {
    var key = row.photo_id ? sidewalkKey_(setName, row.point_id, row.photo_id) : '';
    var previewKey = row.preview_photo_id ? sidewalkKey_(setName, row.point_id, row.preview_photo_id) : '';
    var draft = key ? drafts[key] : null;
    var previewDraft = previewKey ? drafts[previewKey] : null;
    var status = sidewalkStatus_(row);
    var decision = '—';
    var reason = '';
    var comment = '';
    var result = '';
    if (row.photo_id) {
      if (draft) {
        decision = draft.decision || '—';
        reason = draft.reason || '';
        comment = draft.comment || '';
      }
      if (!comment && row.review_comment) comment = row.review_comment;
      result = sidewalkDraftResult_(draft || previewDraft);
    } else {
      reason = row.rejected_comment || (previewDraft ? previewDraft.reason : '') || '';
      result = sidewalkDraftResult_(previewDraft);
    }

    var photoUrl = row.photo_token ? SIDEWALK_CFG.api + '/photo-thumb/' + encodeURIComponent(row.photo_token) : '';
    var mapUrl = sidewalkMapUrl_(setName, row);
    var data = new Array(20).fill('');
    data[0] = index + 1;
    data[1] = row.district || '';
    data[2] = row.address || '';
    data[3] = row.point_no || '';
    if (setName === 'odh') {
      data[4] = row.frame == null ? '' : row.frame;
      data[6] = status;
      data[12] = row.no_sidewalk ? 'да' : '';
    } else {
      data[4] = row.role || '';
      data[5] = row.side || '';
      data[7] = status;
    }
    data[config.decision - 1] = decision;
    data[config.reason - 1] = reason;
    data[config.comment - 1] = comment;
    data[config.result - 1] = result;
    data[13] = row.point_id || '';
    data[14] = row.photo_id || '';
    data[15] = setName;
    data[16] = row.district_raw || row.district || '';
    data[17] = photoUrl;
    data[18] = key;
    data[19] = previewKey;
    values.push(data);

    // URL вписан в формулу, а не взят из скрытой колонки: так сортировка
    // фильтром не подменит фото соседней строкой.
    photoFormulas.push([photoUrl ? '=IMAGE("' + sidewalkFormulaText_(photoUrl) + '",4,160,120)' : '']);
    mapFormulas.push([mapUrl ? '=HYPERLINK("' + sidewalkFormulaText_(mapUrl) + '","На карте")' : '']);

    counts.photo += row.photo_id ? 1 : 0;
    counts[status === 'Принято' ? 'accepted' : status === 'На проверке' ? 'pending'
      : status === 'На доработке' ? 'rework' : 'empty'] += 1;
    counts.noSidewalk += row.no_sidewalk ? 1 : 0;
    if (row.photo_id && draft && draft.decision && draft.decision !== draft.sent_decision) counts.pendingSend += 1;
  });

  sheet.getRange(SIDEWALK_CFG.firstRow, 1, rows.length, 20).setValues(values);
  sheet.getRange(SIDEWALK_CFG.firstRow, config.photo, rows.length, 1).setFormulas(photoFormulas);
  sheet.getRange(SIDEWALK_CFG.firstRow, config.map, rows.length, 1).setFormulas(mapFormulas);
  try { sheet.setRowHeights(SIDEWALK_CFG.firstRow, rows.length, 96); } catch (_) { /* старые версии */ }

  var summary = 'Обновлено ' + sidewalkMoscow_(new Date()) + ' МСК'
    + ' · строк: ' + counts.total
    + ' · с фото: ' + counts.photo
    + ' · принято: ' + counts.accepted
    + ' · на проверке: ' + counts.pending
    + ' · на доработке: ' + counts.rework
    + ' · нет фото: ' + counts.empty
    + (setName === 'odh' ? ' · нет тротуара: ' + counts.noSidewalk : '')
    + ' · к отправке: ' + counts.pendingSend;
  sheet.getRange(2, 1).setValue(summary).setFontColor('#555555');
}

function sidewalkStatus_(row) {
  var labels = { accepted: 'Принято', pending: 'На проверке', empty: 'Нет фото', rework: 'На доработке' };
  var state = row.photo_state || 'empty';
  return labels[state] || String(state);
}

function sidewalkDraftResult_(draft) {
  if (!draft) return '';
  if (draft.sent_decision && draft.sent_decision === draft.decision && draft.sent_at) {
    return 'Отправлено ' + sidewalkMoscow_(new Date(draft.sent_at)) + ' МСК';
  }
  return draft.result || '';
}

function sidewalkMapUrl_(setName, row) {
  var slug = SIDEWALK_SLUGS[row.district_raw || row.district];
  if (!slug) return '';
  var pointId = setName === 'odh' ? row.point_no : row.point_id;
  if (!pointId) return '';
  var parameter = setName === 'odh' ? 'sidewalkTest' : 'sidewalk';
  return SIDEWALK_CFG.mapBase + slug + '.html?' + parameter + '=' + encodeURIComponent(pointId);
}

/** Отправляет решения из обоих листов. «Проверено» и возврат идемпотентны. */
function sidewalkPush() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  var started = new Date();
  var book;
  var sent = 0;
  var errors = 0;
  try {
    book = sidewalkBook_();
    var drafts = sidewalkReadDrafts_(book);
    sidewalkCapture_(book, drafts);
    sidewalkSaveDrafts_(book, drafts);
    ['odh', 'yards'].forEach(function (setName) {
      var result = sidewalkPushSet_(book, setName, drafts, started);
      sent += result.sent;
      errors += result.errors;
    });
    sidewalkSaveDrafts_(book, drafts);
    sidewalkLog_(book, started, 'push', sent, errors, 'отправлено ' + sent);
  } catch (error) {
    sidewalkLog_(book, started, 'push', sent, errors + 1, String(error && error.message || error).slice(0, 400));
    sidewalkShowError_(book, String(error && error.message || error));
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function sidewalkPushSet_(book, setName, drafts, started) {
  var config = SIDEWALK_SETS[setName];
  var sheet = book.getSheetByName(config.sheet);
  var counters = { sent: 0, skipped: 0, errors: 0 };
  if (!sheet || sheet.getLastRow() < SIDEWALK_CFG.firstRow) return counters;
  var values = sheet.getRange(SIDEWALK_CFG.firstRow, 1, sheet.getLastRow() - SIDEWALK_CFG.firstRow + 1, 20).getValues();
  var batch = [];

  values.forEach(function (row, index) {
    var key = String(row[config.key - 1] || '');
    var photoId = String(row[14] || '');
    var decision = String(row[config.decision - 1] || '').trim();
    if (!decision || decision === '—') return;
    if (decision !== 'Проверено' && decision !== 'Вернуть на доработку') {
      sidewalkSetResult_(sheet, config, SIDEWALK_CFG.firstRow + index, 'Не отправлено: неизвестное решение');
      counters.errors += 1;
      return;
    }
    if (!key || !photoId) {
      // Строка без активного снимка: решение отметить можно, но отправлять
      // нечего. Пишем причину в лист, чтобы она не пропала молча.
      sidewalkSetResult_(sheet, config, SIDEWALK_CFG.firstRow + index, 'Не отправлено: нет активного снимка');
      counters.errors += 1;
      return;
    }
    var reason = String(row[config.reason - 1] || '').trim();
    var comment = String(row[config.comment - 1] || '').trim();
    if (decision === 'Вернуть на доработку' && !reason && !comment) {
      sidewalkSetResult_(sheet, config, SIDEWALK_CFG.firstRow + index, 'Не отправлено: укажите причину возврата');
      counters.errors += 1;
      return;
    }
    var draft = drafts[key];
    if (!draft) {
      draft = { key: key, set_name: setName, point_id: String(row[13] || ''), photo_id: photoId,
        decision: decision, reason: reason, comment: comment,
        sent_decision: '', sent_at: '', result: '', updated_at: new Date().toISOString() };
      drafts[key] = draft;
    }
    // Решение и текст берём из листа: push может выполняться отдельно от sync.
    draft.decision = decision;
    draft.reason = reason;
    draft.comment = comment;
    if (draft.sent_decision === decision && draft.sent_at
        && String(draft.result || '').indexOf('Отправлено') === 0) {
      counters.skipped += 1;
      return;
    }
    if (String(row[config.status - 1] || '') !== 'Принято') {
      draft.result = 'Ждёт приёмки снимка';
      draft.sent_decision = '';
      draft.updated_at = new Date().toISOString();
      drafts[key] = draft;
      sidewalkSetResult_(sheet, config, SIDEWALK_CFG.firstRow + index, draft.result);
      counters.skipped += 1;
      return;
    }
    batch.push({
      rowNumber: SIDEWALK_CFG.firstRow + index,
      key: key,
      draft: draft,
      payload: {
        client_id: sidewalkClientId_(setName, String(row[13] || ''), photoId, decision),
        point_id: String(row[13] || ''),
        photo_id: photoId,
        decision: decision === 'Проверено' ? 'verified' : 'rework',
        reason: reason,
        comment: comment,
        reviewed_by: sidewalkUser_(),
        reviewed_at: draft.updated_at || started.toISOString()
      }
    });
  });

  for (var offset = 0; offset < batch.length; offset += SIDEWALK_CFG.chunk) {
    var chunk = batch.slice(offset, offset + SIDEWALK_CFG.chunk);
    var response;
    try {
      response = sidewalkAuthorizedFetch_(SIDEWALK_CFG.api + '/sheet-decisions', {
        method: 'post',
        contentType: 'application/json',
        payload: JSON.stringify({ set: setName, decisions: chunk.map(function (item) { return item.payload; }) })
      });
    } catch (error) {
      chunk.forEach(function (item) {
        item.draft.result = 'Не отправлено: ' + String(error && error.message || error).slice(0, 160);
        item.draft.sent_decision = '';
        item.draft.updated_at = new Date().toISOString();
        drafts[item.key] = item.draft;
        sidewalkSetResult_(sheet, config, item.rowNumber, item.draft.result);
        counters.errors += 1;
      });
      continue;
    }
    var code = response.getResponseCode();
    if (code !== 200) {
      var message = 'Не отправлено: HTTP ' + code + ' ' + response.getContentText().slice(0, 140);
      chunk.forEach(function (item) {
        item.draft.result = message;
        item.draft.sent_decision = '';
        item.draft.updated_at = new Date().toISOString();
        drafts[item.key] = item.draft;
        sidewalkSetResult_(sheet, config, item.rowNumber, item.draft.result);
        counters.errors += 1;
      });
      continue;
    }
    var body;
    try { body = JSON.parse(response.getContentText()); } catch (_) { body = {}; }
    var results = body.results || [];
    if (results.length !== chunk.length) {
      chunk.forEach(function (item) {
        item.draft.result = 'Не отправлено: служба вернула неполный ответ';
        item.draft.sent_decision = '';
        item.draft.updated_at = new Date().toISOString();
        drafts[item.key] = item.draft;
        sidewalkSetResult_(sheet, config, item.rowNumber, item.draft.result);
        counters.errors += 1;
      });
      continue;
    }
    chunk.forEach(function (item, index) {
      var result = results[index] || {};
      if (result.applied) {
        item.draft.sent_decision = item.draft.decision;
        item.draft.sent_at = new Date().toISOString();
        item.draft.result = 'Отправлено ' + sidewalkMoscow_(new Date()) + ' МСК';
        counters.sent += 1;
      } else {
        item.draft.sent_decision = '';
        item.draft.result = 'Не отправлено: ' + sidewalkError_(result.error);
        counters.errors += 1;
      }
      item.draft.updated_at = new Date().toISOString();
      drafts[item.key] = item.draft;
      sidewalkSetResult_(sheet, config, item.rowNumber, item.draft.result);
    });
  }
  return counters;
}

function sidewalkSetResult_(sheet, config, rowNumber, text) {
  sheet.getRange(rowNumber, config.result).setValue(text);
}

function sidewalkError_(code) {
  var map = {
    photo_not_accepted: 'снимок уже не принят (переснят или возвращён)',
    photo_not_found: 'снимок не найден в этом слоте'
  };
  return map[code] || String(code || 'неизвестная ошибка');
}

function sidewalkUser_() {
  try { return Session.getActiveUser().getEmail() || 'sheet'; } catch (_) { return 'sheet'; }
}

function sidewalkClientId_(setName, pointId, photoId, decision) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    setName + '|' + pointId + '|' + photoId + '|' + decision, Utilities.Charset.UTF_8);
  return digest.map(function (byte) {
    var value = (byte & 0xff).toString(16);
    return value.length === 1 ? '0' + value : value;
  }).join('').slice(0, 32);
}

function sidewalkKey_(setName, pointId, photoId) {
  return setName + '|' + String(pointId || '') + '|' + String(photoId || '');
}

function sidewalkFormulaText_(value) {
  return String(value).replace(/"/g, '""');
}

function sidewalkMoscow_(date) {
  return Utilities.formatDate(date instanceof Date ? date : new Date(date),
    'Europe/Moscow', 'dd.MM.yyyy HH:mm');
}

function sidewalkIso_(value) {
  var date = value instanceof Date ? value : new Date(value);
  return isNaN(date.getTime()) ? '' : date.toISOString();
}

function sidewalkColumn_(number) {
  var name = '';
  while (number > 0) {
    var remainder = (number - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    number = Math.floor((number - 1) / 26);
  }
  return name;
}

function sidewalkLog_(book, started, action, added, errors, message) {
  if (!book) return;
  var sheet = book.getSheetByName('_log');
  if (!sheet) return;
  sheet.appendRow([started || new Date(), action || '', '', added || 0, errors || 0,
    String(message || '').slice(0, 500)]);
  var last = sheet.getLastRow();
  if (last > 2000) sheet.deleteRows(2, last - 2000);
}

/** Ручной прогон: обновить данные и сразу отправить готовые решения. */
function sidewalkSyncAndPush() {
  sidewalkSync();
  sidewalkPush();
}

function sidewalkInstallTriggers() {
  sidewalkRemoveTriggers();
  ScriptApp.newTrigger('sidewalkSync').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('sidewalkPush').timeBased().everyMinutes(10).create();
  sidewalkNotify_('Автообновление тротуаров включено: данные и решения каждые 10 минут.');
}

function sidewalkRemoveTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    var handler = trigger.getHandlerFunction();
    if (handler === 'sidewalkSync' || handler === 'sidewalkPush') ScriptApp.deleteTrigger(trigger);
  });
}

/**
 * Необязательное меню. Чтобы оно появилось, добавьте sidewalkAddMenu(); в
 * начало существующего onOpen книги ДП/СП. Отдельный onOpen здесь не
 * определяется, чтобы не конфликтовать с живым проектом.
 */
function sidewalkAddMenu() {
  SpreadsheetApp.getUi().createMenu('Тротуары')
    .addItem('Обновить книгу', 'sidewalkSync')
    .addItem('Отправить решения', 'sidewalkPush')
    .addItem('Обновить и отправить', 'sidewalkSyncAndPush')
    .addSeparator()
    .addItem('Подготовить книгу', 'sidewalkSetup')
    .addItem('Включить автообновление', 'sidewalkInstallTriggers')
    .addItem('Выключить автообновление', 'sidewalkRemoveTriggers')
    .addToUi();
}
