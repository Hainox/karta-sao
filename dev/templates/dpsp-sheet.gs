/**
 * Сводно-отчётная таблица «Оцифровка ДП/СП и МАФ САО».
 *
 * Кабинет оцифровки: https://hainox.github.io/karta-sao/dp-sp-cabinet/
 * API: https://obhod-sao.ru/photo-api/object-photo-points/dpsp
 *
 * Установка (один раз, в самой таблице):
 *   1. Расширения → Apps Script → вставить этот файл целиком, сохранить.
 *   2. Шестерёнка «Настройки проекта» → «Свойства скрипта» → добавить:
 *        SAO_TOKEN    = токен службы (Bearer); можно не задавать, если есть SAO_LOGIN/SAO_PASSWORD
 *        SAO_LOGIN    = логин служебной учётки префектуры
 *        SAO_PASSWORD = пароль служебной учётки
 *      Скрипт сам обновляет токен по логину/паролю, когда сессия истекает (8 часов).
 *   3. Перезагрузить таблицу → меню «ДП/СП · Оцифровка» → «Собрать структуру нового цикла».
 *      Существующие листы и ручные решения не изменяются. Новый цикл обновляется отдельно.
 *   4. «Обновить сейчас» — залить данные. Затем «Включить автообновление (10 мин)».
 *
 * Структура: площадка — родительский объект (лист «Площадки»), МАФ — дочерние
 * (лист «МАФ», связаны по site_id). «Сверка» — по площадке, с решениями.
 */

var CFG = {
  api: 'https://obhod-sao.ru/photo-api/object-photo-points/dpsp',
  playgroundApi: 'https://obhod-sao.ru/photo-api/object-photo-points/playgrounds',
  apiLogin: 'https://obhod-sao.ru/photo-api/auth/login',
  mapBase: 'https://hainox.github.io/karta-sao/districts/',
  sheets: { summary: 'Свод', sites: 'Площадки', maf: 'МАФ', cross: 'Сверка', dict: 'Справочники', log: 'Журнал', state: '_state' },
  // Ёмкости с запасом: площадок ~2 900, МАФ — до нескольких тысяч единиц.
  sitesCap: 5000,
  mafCap: 12000,
  decisions: ['—', 'Сверено', 'Требует правки'],
  reasons: ['Не тот адрес', 'Не все МАФ', 'Лишние МАФ', 'Нет МАФ, а должны быть', 'Другое']
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('ДП/СП · Оцифровка')
    .addItem('Собрать структуру нового цикла', 'installCaptureSheets')
    .addItem('Обновить сейчас', 'syncSheet')
    .addSeparator()
    .addItem('Включить автообновление (10 мин)', 'installTriggers')
    .addItem('Выключить автообновление', 'removeTriggers')
    .addToUi();
}

// Старые листы — архив прежней сверки. Правки в них больше не запускают
// пересборку нового цикла и не теряются при переключении очередей.
/* ---------------- Сеть и авторизация ---------------- */

function credentials() {
  var props = PropertiesService.getScriptProperties();
  var token = props.getProperty('SAO_TOKEN');
  var login = props.getProperty('SAO_LOGIN');
  var password = props.getProperty('SAO_PASSWORD');
  if (!token && (!login || !password)) {
    throw new Error('Задайте SAO_TOKEN либо SAO_LOGIN и SAO_PASSWORD в свойствах скрипта');
  }
  return { props: props, token: token, login: login, password: password };
}

function renewToken(creds) {
  if (!creds.login || !creds.password) throw new Error('Сессия истекла: обновите SAO_TOKEN в свойствах скрипта');
  var response = UrlFetchApp.fetch(CFG.apiLogin, {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    payload: JSON.stringify({ login: creds.login, email: creds.login, password: creds.password })
  });
  if (response.getResponseCode() !== 200) {
    throw new Error('Не удалось обновить токен: HTTP ' + response.getResponseCode());
  }
  var fresh = JSON.parse(response.getContentText()).token;
  if (!fresh) throw new Error('Сервер не вернул токен');
  creds.props.setProperty('SAO_TOKEN', fresh);
  creds.token = fresh;
}

function fetchJson(path) {
  var creds = credentials();
  for (var attempt = 0; attempt < 2; attempt += 1) {
    var response = UrlFetchApp.fetch(CFG.api + path, {
      headers: { Authorization: 'Bearer ' + creds.token }, muteHttpExceptions: true
    });
    if (response.getResponseCode() === 401 && attempt === 0) { renewToken(creds); continue; }
    if (response.getResponseCode() !== 200) {
      throw new Error('HTTP ' + response.getResponseCode() + ': ' + response.getContentText().slice(0, 200));
    }
    return JSON.parse(response.getContentText());
  }
  throw new Error('HTTP 401 после обновления токена');
}

function thumb(tokenValue, api) {
  return tokenValue ? (api || CFG.api) + '/photo-thumb/' + tokenValue + '.jpg' : '';
}

/* ---------------- Служебные листы ---------------- */

function ensureSheet(name, headers, widths, hiddenColumns) {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName(name);
  if (!sheet) sheet = book.insertSheet(name);
  if (headers && headers.length) {
    var head = sheet.getRange(1, 1, 1, headers.length);
    head.setValues([headers]).setFontWeight('bold').setBackground('#123d33').setFontColor('#ffffff');
    sheet.setFrozenRows(1);
  }
  (widths || []).forEach(function (width, index) {
    if (width > 0) sheet.setColumnWidth(index + 1, width);
  });
  (hiddenColumns || []).forEach(function (column) { sheet.hideColumns(column); });
  return sheet;
}

// Ёмкость под полный объём: ~2 900 площадок и до 12 000 МАФ не влезают
// в стандартные 1 000 строк нового листа, а getRange за границей бросает ошибку.
function ensureCapacity(sheet, rows) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
}

function writeTable(sheet, rows, width, startRow) {
  var from = startRow || 2;
  if (rows.length) {
    sheet.getRange(from, 1, rows.length, width).setValues(rows);
  }
  var extra = Math.max(sheet.getLastRow() - from - rows.length + 1, 0);
  if (extra > 0) sheet.getRange(from + rows.length, 1, extra, width).clearContent();
  return rows.length;
}

function installSheets() {
  var book = SpreadsheetApp.getActive();
  ensureSheet(CFG.sheets.sites,
    ['site_id', 'ID площадки', 'Район', 'Слаг', 'Вид', 'Адрес площадки', 'Широта', 'Долгота',
      'Статус фото', 'МАФ, шт.', 'Оцифровано', 'Обновлено МАФ', 'Фото площадки (URL)'],
    [0, 110, 130, 0, 70, 320, 90, 90, 110, 80, 130, 130, 0], [1, 4, 13]);
  ensureSheet(CFG.sheets.maf,
    ['maf_id', 'site_id', 'ID площадки', 'Район', 'Вид', 'Адрес площадки', 'Тип МАФ', 'Кол-во',
      'Состояние', 'Комментарий', 'Фото (URL)', 'Создано', 'Обновлено'],
    [0, 0, 110, 130, 70, 320, 180, 70, 130, 260, 0, 130, 130], [1, 2, 11]);
  ensureSheet(CFG.sheets.dict,
    ['Решение сверки', 'Причина', 'Район', 'Слаг', 'Вид', 'Состояние МАФ', 'Типы МАФ'],
    [150, 190, 140, 0, 70, 140, 190], [4]);
  ensureSheet(CFG.sheets.log, ['Время', 'Результат', 'Площадок', 'МАФ', 'Ошибки'], [140, 90, 90, 90, 420]);
  ensureSheet(CFG.sheets.state, ['Ключ', 'Значение'], [120, 320]);
  ensureCapacity(book.getSheetByName(CFG.sheets.sites), CFG.sitesCap + 10);
  ensureCapacity(book.getSheetByName(CFG.sheets.maf), CFG.mafCap + 10);
  installCrossSheet();
  installSummarySheet();
  SpreadsheetApp.getActive().toast('Структура готова. Дальше — «Обновить сейчас».', 'ДП/СП · Оцифровка', 6);
}

function installSummarySheet() {
  var sheet = ensureSheet(CFG.sheets.summary, null, [150, 110, 110, 110, 110, 100, 120]);
  var formulas = [
    ['A3', 'Данные кабинета на', '=IF(COUNT(Площадки!L:L)=0;"нет данных";MAX(Площадки!L:L))'],
    ['A4', 'Последняя синхронизация', '=IF(COUNT(Журнал!A:A)=0;"нет данных";MAX(Журнал!A:A))'],
    ['A5', 'Статус синхронизации', "='_state'!B3"]
  ];
  formulas.forEach(function (row) {
    sheet.getRange(row[0]).setValue(row[1]);
    sheet.getRange(row[0].replace('A', 'B')).setFormula(row[2]);
  });
  sheet.getRange('A7').setValue('Показатели оцифровки').setFontWeight('bold');
  sheet.getRange('A8:H8').setValues([['', 'Всего площадок', 'Оцифровано', '% оцифровки', 'МАФ, шт.', 'МАФ с фото', 'Сверено', 'Требует правки']])
    .setFontWeight('bold').setBackground('#e7f4ee');
  var cap = CFG.sitesCap, mafCap = CFG.mafCap;
  sheet.getRange('B9:H9').setFormulas([
    ['=COUNTA(Площадки!$B$2:$B$' + cap + ')',
      '=COUNT(Площадки!$K$2:$K$' + cap + ')',
      '=IFERROR(C9/B9;0)',
      '=SUM(МАФ!$H$2:$H$' + mafCap + ')',
      '=COUNTIF(МАФ!$K$2:$K$' + mafCap + ';"http*")',
      '=COUNTIF(Сверка!$J$7:$J;"Сверено")+COUNTIF(Сверка!$J$7:$J;"Требует правки")',
      '=COUNTIF(Сверка!$J$7:$J;"Требует правки")']
  ]);
  sheet.getRange('A11:G11').setValues([['Район', 'Всего', 'Оцифровано', '% оцифровки', 'МАФ, шт.', 'Сверено', 'Требует правки']])
    .setFontWeight('bold').setBackground('#123d33').setFontColor('#ffffff');
  var rows = [];
  for (var r = 0; r < 16; r += 1) {
    var row = 12 + r;
    rows.push([
      '=Справочники!$C$' + (2 + r),
      '=COUNTIF(Площадки!$C:$C;$A' + row + ')',
      '=COUNTIFS(Площадки!$C:$C;$A' + row + ';Площадки!$K:$K;">0")',
      '=IFERROR(C' + row + '/B' + row + ';0)',
      '=SUMIFS(МАФ!$H:$H;МАФ!$D:$D;$A' + row + ')',
      '=COUNTIFS(Сверка!$B:$B;$A' + row + ';Сверка!$J:$J;"Сверено")+COUNTIFS(Сверка!$B:$B;$A' + row + ';Сверка!$J:$J;"Требует правки")',
      '=COUNTIFS(Сверка!$B:$B;$A' + row + ';Сверка!$J:$J;"Требует правки")'
    ]);
  }
  rows.push([
    'ИТОГО',
    '=SUM(B12:B27)', '=SUM(C12:C27)', '=IFERROR(C28/B28;0)',
    '=SUM(E12:E27)', '=SUM(F12:F27)', '=SUM(G12:G27)'
  ]);
  sheet.getRange('A12:G28').setFormulas(rows);
  sheet.getRange('D9').setNumberFormat('0.0%');
  sheet.getRange('D12:D28').setNumberFormat('0.0%');
  applyPercentColors();
}

function installCrossSheet() {
  var sheet = ensureSheet(CFG.sheets.cross, null, [40, 130, 60, 300, 110, 340, 80, 130, 220, 130, 170, 220, 170, 130, 0, 90], [15]);
  ensureCapacity(sheet, CFG.sitesCap + 10);
  sheet.getRange('B1').setValue('Все районы').setBackground('#e7f4ee');
  sheet.getRange('A1').setValue('Район:').setFontWeight('bold');
  sheet.getRange('A2').setValue('Показать:').setFontWeight('bold');
  sheet.getRange('B2').setValue('Все').setBackground('#e7f4ee');
  sheet.getRange('B3').setFormula('=IF(COUNT(Площадки!L:L)=0;"нет данных";MAX(Площадки!L:L))');
  sheet.getRange('A3').setValue('Данные на:').setFontWeight('bold');
  sheet.getRange('A6:G6').setValues([['№', 'Район', 'Вид', 'Адрес площадки', 'ID площадки', 'МАФ на площадке', 'МАФ, шт.']])
    .setFontWeight('bold').setBackground('#123d33').setFontColor('#ffffff');
  sheet.getRange('H6:P6').setValues([['Оцифровано', 'Фото площадки', 'Решение сверки', 'Причина', 'Комментарий', 'Кто проверил', 'Когда проверено', 'site_id', 'На карте']])
    .setFontWeight('bold').setBackground('#123d33').setFontColor('#ffffff');
  sheet.setFrozenRows(6);
  installCrossFilters();
  var districts = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.dict);
  var decisions = SpreadsheetApp.newDataValidation().requireValueInRange(
    districts.getRange('A2:A4'), true).build();
  var reasons = SpreadsheetApp.newDataValidation().requireValueInRange(
    districts.getRange('B2:B6'), true).build();
  sheet.getRange('J7:J' + CFG.sitesCap).setDataValidation(decisions);
  sheet.getRange('K7:K' + CFG.sitesCap).setDataValidation(reasons);
}

// Фильтры B1/B2 «Сверки». Районы собираются из «Справочников», а «Все районы»
// добавляется явно: в диапазоне C2:C17 его нет, и без этого выбрать «все»
// обратно из выпадающего списка нельзя.
function installCrossFilters() {
  var book = SpreadsheetApp.getActive();
  var sheet = book.getSheetByName(CFG.sheets.cross);
  var dict = book.getSheetByName(CFG.sheets.dict);
  if (!sheet || !dict) return;
  var names = dict.getRange('C2:C17').getValues()
    .map(function (value) { return String(value[0]); })
    .filter(String);
  sheet.getRange('B1').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Все районы'].concat(names), true).build());
  sheet.getRange('B2').setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Все', 'Только без решения', 'Только не оцифровано'], true).build());
}

/* ---------------- Синхронизация ---------------- */

function legacySyncSheet() {
  var lock = LockService.getDocumentLock();
  if (!lock.tryLock(30000)) return;
  var started = new Date();
  try {
    var data = fetchJson('/sheet.json');
    var sites = writeSites(data.sites || []);
    var maf = writeMaf(data.maf || []);
    writeDictionaries(data.dictionaries || {});
    installCrossFilters();
    refreshCross(data);
    writeState('ok', data.generated_at);
    logRow(started, sites, maf, 'OK');
  } catch (error) {
    writeState('ошибка: ' + String(error && error.message || error).slice(0, 300), null);
    logRow(started, 0, 0, String(error && error.message || error).slice(0, 400));
    throw error;
  } finally {
    lock.releaseLock();
  }
}

function stateLabel(photoState) {
  if (photoState === 'accepted') return 'Принято';
  if (photoState === 'pending') return 'На проверке';
  if (photoState === 'rework') return 'На доработке';
  return 'Нет фото';
}

// API отдаёт код состояния; на листе — подпись по-русски.
var CONDITIONS = { ok: 'Исправно', repair: 'Требует ремонта', broken: 'Неисправно' };

function kindLabel(kind) { return kind === 'dp' ? 'ДП' : 'СП'; }

function writeSites(sites) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.sites);
  var rows = sites.map(function (site) {
    return [
      site.point_id, String(site.source_id || ''), site.district || '', site.district_slug || '',
      kindLabel(site.kind), site.address || '',
      site.latitude == null ? '' : site.latitude, site.longitude == null ? '' : site.longitude,
      stateLabel(site.photo_state), site.maf_count || 0,
      site.checked_at ? new Date(site.checked_at) : '',
      site.last_maf_at ? new Date(site.last_maf_at) : '',
      thumb(site.photo_token, CFG.playgroundApi)
    ];
  });
  return writeTable(sheet, rows, 13);
}

function writeMaf(maf) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.maf);
  var rows = maf.map(function (item) {
    return [
      item.id, item.point_id, String(item.source_id || ''), item.district || '', kindLabel(item.kind),
      item.address || '', item.type_label || item.type_code || '', item.quantity || 1,
      CONDITIONS[item.condition] || item.condition || '', item.comment || '', thumb(item.photo_token),
      item.created_at ? new Date(item.created_at) : '', item.updated_at ? new Date(item.updated_at) : ''
    ];
  });
  return writeTable(sheet, rows, 13);
}

function writeDictionaries(dictionaries) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.dict);
  var conditions = dictionaries.conditions || [];
  var kinds = dictionaries.kinds || [];
  var districts = dictionaries.districts || [];
  var types = dictionaries.types || [];
  var height = Math.max(districts.length, types.length, 16);
  var rows = [];
  for (var i = 0; i < height; i += 1) {
    rows.push([
      CFG.decisions[i] || '', CFG.reasons[i] || '',
      districts[i] ? districts[i].name : '', districts[i] ? districts[i].slug : '',
      kinds[i] ? kinds[i].label : '',
      conditions[i] ? conditions[i].label : '',
      types[i] ? types[i].label : ''
    ]);
  }
  writeTable(sheet, rows, 7);
}

/* ---------------- Сверка: одна строка = площадка ---------------- */

function refreshCrossMenu() {
  var data = { sites: readSitesSheet(), maf: readMafSheet() };
  rebuildCross(data, SpreadsheetApp.getActive().getSheetByName(CFG.sheets.cross));
}

function refreshCross(data) {
  // После записи листов читаем свежие значения: состав «Сверки» строится по таблице.
  rebuildCross({ sites: readSitesSheet(), maf: readMafSheet() },
    SpreadsheetApp.getActive().getSheetByName(CFG.sheets.cross));
}

function readSitesSheet() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.sites);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 13).getValues().map(function (row) {
    return {
      site_id: row[0], id: String(row[1]), district: row[2], slug: row[3], kind: row[4],
      address: row[5], photo_state: row[8], maf_count: row[9], checked_at: row[10],
      photo_url: row[12]
    };
  }).filter(function (site) { return site.site_id; });
}

function readMafSheet() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.maf);
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 13).getValues().map(function (row) {
    return { maf_id: row[0], site_id: row[1], type: row[6], quantity: row[7] };
  }).filter(function (item) { return item.maf_id && item.site_id; });
}

function rebuildCross(data, sheet) {
  var bySite = {};
  (data.maf || []).forEach(function (item) {
    (bySite[item.site_id] = bySite[item.site_id] || []).push(item.type + ' × ' + item.quantity);
  });
  // Прошлые решения читаем до записи: скрытая колонка O — единственный
  // надёжный ключ, адрес площадки не уникален.
  var saved = currentDecisions(sheet);
  var district = String(sheet.getRange('B1').getValue() || '').trim();
  var show = String(sheet.getRange('B2').getValue() || 'Все').trim();
  var sites = (data.sites || []).filter(function (site) {
    if (district && district !== 'Все районы' && site.district !== district) return false;
    if (show === 'Только без решения') {
      var decision = (saved[site.site_id] || {}).decision;
      return !decision || decision === '—';
    }
    if (show === 'Только не оцифровано') return !site.checked_at;
    return true;
  });
  var rows = [], formulas = [], stamps = [];
  sites.forEach(function (site, index) {
    var past = saved[site.site_id] || {};
    var mapUrl = site.slug ? CFG.mapBase + site.slug + '.html?playground=' + site.site_id : '';
    var row = 7 + index;
    // A..H — данные; I — формула фото; J..N — ручные решения; O — ключ; P — ссылка.
    rows.push([
      index + 1, site.district, site.kind, site.address, site.id,
      (bySite[site.site_id] || []).join(' · ') || '—', site.maf_count || 0,
      site.checked_at ? site.checked_at : ''
    ]);
    formulas.push([
      site.photo_url ? '=IMAGE(VLOOKUP($O' + row + ';Площадки!$A:$M;13;FALSE);1)' : '',
      past.decision || '—', past.reason || '', past.comment || '',
      past.who || '', past.when || '', site.site_id,
      mapUrl ? '=HYPERLINK("' + mapUrl + '";"На карте")' : ''
    ]);
    if ((past.decision || '—') !== '—' && !past.who && !past.when) stamps.push(row);
  });
  writeTable(sheet, rows, 8, 7);
  if (formulas.length) {
    sheet.setRowHeights(7, formulas.length, 160);
    sheet.setColumnWidth(9, 220);
    sheet.getRange(7, 9, formulas.length, 7).setValues(formulas.map(function (f) {
      return [f[0], f[1], f[2], f[3], f[4], f[5], f[6]];
    }));
    sheet.getRange(7, 16, formulas.length, 1).setFormulas(formulas.map(function (f) { return [f[7]]; }));
  }
  // Хвост за пределами нового набора: старые формулы фото и ссылки счищаем,
  // иначе остаются кадры уже отфильтрованных площадок.
  var tailRows = sheet.getMaxRows() - 6 - formulas.length;
  if (tailRows > 0) sheet.getRange(7 + formulas.length, 9, tailRows, 8).clearContent();
  // Кто и когда — при первом появлении решения. В триггерных прогонах автор
  // неизвестен (пустой email): пишем только время, кто — при ручной пересборке.
  var who = Session.getActiveUser().getEmail();
  stamps.forEach(function (row) {
    if (who) sheet.getRange(row, 13).setValue(who);
    sheet.getRange(row, 14).setValue(new Date());
  });
}

// Прошлые решения одним чтением J..O: решение, причина, комментарий, кто,
// когда и скрытый ключ site_id (колонка O).
function currentDecisions(sheet) {
  var last = sheet.getLastRow();
  var saved = {};
  if (last >= 7) {
    sheet.getRange(7, 10, last - 6, 6).getValues().forEach(function (row) {
      if (!row[5]) return;
      saved[row[5]] = {
        decision: row[0], reason: row[1], comment: row[2], who: row[3], when: row[4] || ''
      };
    });
  }
  return saved;
}

/* ---------------- Журнал, состояние, триггеры ---------------- */

function writeState(status, generatedAt) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.state);
  var stamp = generatedAt ? new Date(generatedAt) : new Date();
  sheet.getRange(1, 1, 4, 2).setValues([
    ['ключ', 'значение'],
    ['last_sync', stamp],
    ['sync_status', status],
    ['api', CFG.api]
  ]);
}

function logRow(started, sites, maf, status) {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CFG.sheets.log);
  sheet.appendRow([new Date(), status, sites, maf, '']);
}

function installTriggers() {
  removeTriggers();
  ScriptApp.newTrigger('syncSheet').timeBased().everyMinutes(10).create();
  SpreadsheetApp.getActive().toast('Автообновление включено: каждые 10 минут.', 'ДП/СП · Оцифровка', 6);
}

function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (trigger) {
    if (trigger.getHandlerFunction() === 'syncSheet') ScriptApp.deleteTrigger(trigger);
  });
}

/**
 * Цветовая шкала для колонок «% оцифровки»: 100 % — зелёный, 80–99 % —
 * светло-зелёный, 60–80 % — жёлтый, ниже — красные оттенки. Повторный запуск
 * заменяет только правила на процентных колонках.
 */
function applyPercentColors() {
  var book = SpreadsheetApp.getActive();
  var bands = [
    { min: 0.9995, color: '#00B050' }, { min: 0.8, color: '#A5D6A7' },
    { min: 0.6, color: '#FFF59D' }, { min: 0.4, color: '#FF8A65' }, { min: 0.2, color: '#E53935' }
  ];
  var touched = 0;
  var sheet = book.getSheetByName(CFG.sheets.summary);
  if (!sheet) return;
  [sheet.getRange('D9'), sheet.getRange('D12:D28')].forEach(function (range) {
    var rules = sheet.getConditionalFormatRules().filter(function (rule) {
      return !rule.getRanges().some(function (existing) {
        return !(existing.getLastRow() < range.getRow() || existing.getRow() > range.getLastRow()
          || existing.getLastColumn() < range.getColumn() || existing.getColumn() > range.getLastColumn());
      });
    });
    bands.forEach(function (band) {
      rules.push(SpreadsheetApp.newConditionalFormatRule()
        .whenNumberGreaterThanOrEqualTo(band.min).setBackground(band.color).setRanges([range]).build());
    });
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberLessThan(0.2).setBackground('#B71C1C').setRanges([range]).build());
    sheet.setConditionalFormatRules(rules);
    touched += 1;
  });
  book.toast('Покрашено диапазонов: ' + touched, 'Проценты', 5);
}

/* ---------------- Новая фотофиксация и приёмка ---------------- */

// Названия выделены в собственное пространство, чтобы не перезаписать
// прежние Площадки / МАФ / Сверку, включая ручные решения операторов.
var CAPTURE = {
  base: 'https://hainox.github.io/karta-sao/',
  mapBase: 'https://hainox.github.io/karta-sao/districts/',
  names: {summary:'Свод · новый цикл',all:'Площадки · новый цикл',work:'В работе · ДПСП',
    submitted:'Отработанные · ДПСП',accepted:'Принятые · ДПСП',rework:'На доработке · ДПСП',
    photos:'Фото площадок · ДПСП',maf:'МАФ · новый цикл',log:'Журнал · новый цикл'},
  labels:{work:'Неотработано',submitted:'На приёмке',accepted:'Принято',rework:'На доработке'}
};

function captureText(value) {
  var t = String(value == null ? '' : value);
  // Данные адресов и комментариев не должны интерпретироваться как формулы.
  return /^[=+\-@]/.test(t) ? "'" + t : t;
}
function captureDate(value) {
  var dt=value?new Date(value):null;
  return dt && !isNaN(dt.getTime()) ? Utilities.formatDate(dt,'Europe/Moscow','yyyy-MM-dd HH:mm:ss') : '';
}
function captureDistrict(name) {
  return String(name || '').replace('Савёловский','Савеловский').replace('Хорошёвский','Хорошевский');
}
function captureId(value) {
  var id=String(value||'');
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) throw new Error('Некорректный ID в срезе нового цикла');
  return id;
}
function capturePreview(token, isMaf) {
  return /^[0-9a-f]{32}$/i.test(String(token||''))?
    '=IMAGE("'+CFG.api+(isMaf?'/photo-thumb/':'/capture-thumb/')+token+'.jpg")':'';
}
function captureCabinetLink(site) {
  var id=captureId(site.point_id);
  var review=site.state==='submitted'||site.state==='accepted';
  return CAPTURE.base + (review?'dp-sp-review/':'dp-sp-cabinet/')+'?site='+encodeURIComponent(id)
      +(site.state==='accepted'?'&queue=accepted':'');
}
function captureMapLink(site,slugs) {
  var slug=slugs[captureDistrict(site.district)];
  return slug && /^[a-z0-9-]+$/.test(slug)?CAPTURE.mapBase+slug+'.html?playground='+encodeURIComponent(captureId(site.point_id)):'';
}

function captureSheetSpecs() {
  var sites={headers:['№','Район','Вид','Адрес площадки','ID площадки','Этап','Новых фото','МАФ, записей','МАФ, шт.','МАФ с фото','Передано (МСК)','Решение (МСК)','Комментарий приёмки','На карте','В кабинете','site_id'],
    widths:[55,145,70,330,125,145,90,100,90,95,160,160,340,105,130,150],hidden:[16]};
  return {
    all:sites,work:sites,submitted:sites,accepted:sites,rework:sites,
    summary:{headers:['Район','Всего','Неотработано','На доработке','На приёмке','Принято','Отработано','% отработано','Новых фото','МАФ, записей','МАФ, шт.','МАФ с фото'],
      widths:[155,95,120,120,110,100,110,125,105,115,100,110],hidden:[]},
    photos:{headers:['№','Район','Вид','Адрес площадки','ID площадки','Этап','Кадр','Имя файла','Загружено (МСК)','Фото площадки','На карте','В кабинете','site_id','photo_id'],
      widths:[55,145,70,320,130,145,65,200,165,210,105,130,150,150],hidden:[13,14]},
    maf:{headers:['№','Район','Вид','Адрес площадки','ID площадки','Этап','Тип МАФ','Кол-во','Состояние','Комментарий','Фото МАФ','Обновлено (МСК)','На карте','В кабинете','site_id','maf_id'],
      widths:[55,145,70,320,130,145,200,75,150,320,210,165,105,130,150,150],hidden:[15,16]},
    log:{headers:['Время (МСК)','Результат','Площадок','Обзорных фото','МАФ','Комментарий'],widths:[170,115,95,110,90,400],hidden:[]}
  };
}
function captureEnsureSheet(key) {
  var spec=captureSheetSpecs()[key];
  var book=SpreadsheetApp.getActive();
  var sheet=book.getSheetByName(CAPTURE.names[key])||book.insertSheet(CAPTURE.names[key]);
  if(sheet.getMaxColumns()<spec.headers.length)sheet.insertColumnsAfter(sheet.getMaxColumns(),spec.headers.length-sheet.getMaxColumns());
  var header=sheet.getRange(1,1,1,spec.headers.length);
  header.setValues([spec.headers]).setBackground('#123d33').setFontColor('#ffffff').setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sheet.setRowHeight(1,40);sheet.setFrozenRows(1);
  spec.widths.forEach(function(width,i){sheet.setColumnWidth(i+1,width);});
  spec.hidden.forEach(function(col){sheet.hideColumns(col);});
  return sheet;
}
function installCaptureSheets() {
  Object.keys(captureSheetSpecs()).forEach(captureEnsureSheet);
  SpreadsheetApp.getActive().toast('Новые листы готовы. Старые листы сохранены.','ДП/СП',6);
}
function captureRichLinks(col) {
  return col.map(function(item){
    return [SpreadsheetApp.newRichTextValue().setText(item.url?item.label:'—')
      .setLinkUrl(item.url||null).build()];
  });
}
function captureWrite(key, rows, linkCols, imageCol, imageFormulas) {
  var spec=captureSheetSpecs()[key],sheet=captureEnsureSheet(key);
  var old=Math.max(0,sheet.getLastRow()-1);
  ensureCapacity(sheet,Math.max(2,rows.length+1));
  if(rows.length){
    var body=sheet.getRange(2,1,rows.length,spec.headers.length);
    body.setValues(rows).setVerticalAlignment('middle').setHorizontalAlignment('center').setWrap(true);
    sheet.setRowHeights(2,rows.length,imageCol?152:54);
    Object.keys(linkCols||{}).forEach(function(index){
      sheet.getRange(2,Number(index),rows.length,1).setRichTextValues(captureRichLinks(linkCols[index]));
    });
    if(imageCol)sheet.getRange(2,imageCol,rows.length,1).setFormulas(imageFormulas.map(function(f){return [f];}));
  }
  if(old>rows.length)sheet.getRange(rows.length+2,1,old-rows.length,spec.headers.length).clearContent();
  if(key==='summary'&&rows.length){
    sheet.getRange(2,8,rows.length,1).setNumberFormat('0.0%');
    sheet.getRange(rows.length+1,1,1,spec.headers.length).setFontWeight('bold').setBackground('#e7f4ee');
    if(rows.length>1)sheet.getRange(2,1,rows.length-1,spec.headers.length).setFontWeight('normal').setBackground('#ffffff');
  }
  return sheet;
}
function captureBuild(data,dictionaries) {
  if(!data||!Array.isArray(data.sites)||!Array.isArray(data.photos)||!Array.isArray(data.maf)||!data.generated_at)
    throw new Error('Сервер не вернул полный срез. Листы не обновлены.');
  var parents=Object.create(null), photosBy=Object.create(null), mafBy=Object.create(null), slugs=Object.create(null), districts=Object.create(null);
  (dictionaries.districts||[]).forEach(function(d){var key=captureDistrict(d.name);slugs[key]=d.slug;districts[key]=true;});
  data.sites.forEach(function(s){
    var id=captureId(s.point_id);
    if(parents[id]||!Object.prototype.hasOwnProperty.call(CAPTURE.labels,s.state))throw new Error('Повтор или неизвестный этап площадки');
    parents[id]=s;photosBy[id]=[];mafBy[id]=[];districts[captureDistrict(s.district)]=true;
  });
  var seen=Object.create(null);
  data.photos.forEach(function(p){var id=captureId(p.photo_id),parent=captureId(p.point_id);if(seen[id]||!parents[parent])throw new Error('Повтор или потерянная связь фото');seen[id]=true;photosBy[parent].push(p);});
  seen=Object.create(null);
  data.maf.forEach(function(m){var id=captureId(m.maf_id),parent=captureId(m.point_id);if(seen[id]||!parents[parent])throw new Error('Повтор или потерянная связь МАФ');seen[id]=true;mafBy[parent].push(m);});
  data.sites.forEach(function(s){
    if(Number(s.capture_count)!==photosBy[s.point_id].length||Number(s.maf_count)!==mafBy[s.point_id].length)throw new Error('Несогласованные количества в срезе');
  });
  function quantities(site){
    var maf=mafBy[site.point_id];
    return [maf.length,maf.reduce(function(sum,m){return sum+Number(m.quantity||0);},0),maf.filter(function(m){return !!m.photo_id;}).length];
  }
  function links(site){
    return [{label:'На карте',url:captureMapLink(site,slugs)},{label:'В кабинете',url:captureCabinetLink(site)}];
  }
  function siteTable(items){
    var table={rows:[],links:{14:[],15:[]}};
    items.forEach(function(site,i){
      var counts=quantities(site),link=links(site);
      table.rows.push([i+1,captureText(site.district),kindLabel(site.kind),captureText(site.address),captureText(site.source_id),
        CAPTURE.labels[site.state],photosBy[site.point_id].length,counts[0],counts[1],counts[2],
        captureDate(site.submitted_at),captureDate(site.reviewed_at),captureText(site.review_comment),'','',site.point_id]);
      table.links[14].push(link[0]);table.links[15].push(link[1]);
    });return table;
  }
  var summary=[],total=[0,0,0,0,0,0,0,0,0,0];
  Object.keys(districts).sort(function(a,b){return a.localeCompare(b,'ru');}).forEach(function(d){
    var sites=data.sites.filter(function(s){return captureDistrict(s.district)===d;});
    var counts=[sites.length,0,0,0,0,0,0,0,0,0];
    sites.forEach(function(site){
      counts[{work:1,rework:2,submitted:3,accepted:4}[site.state]]+=1;
      counts[6]+=photosBy[site.point_id].length;
      var q=quantities(site);counts[7]+=q[0];counts[8]+=q[1];counts[9]+=q[2];
    });
    counts[5]=counts[3]+counts[4];counts.forEach(function(value,i){total[i]+=value;});
    summary.push([d,counts[0],counts[1],counts[2],counts[3],counts[4],counts[5],counts[0]?counts[5]/counts[0]:0,counts[6],counts[7],counts[8],counts[9]]);
  });
  summary.push(['ИТОГО',total[0],total[1],total[2],total[3],total[4],total[5],total[0]?total[5]/total[0]:0,total[6],total[7],total[8],total[9]]);
  var photoTable={rows:[],links:{11:[],12:[]},images:[]},mafTable={rows:[],links:{13:[],14:[]},images:[]};
  data.sites.forEach(function(site){
    var link=links(site),preamble=[captureText(site.district),kindLabel(site.kind),captureText(site.address),captureText(site.source_id),CAPTURE.labels[site.state]];
    photosBy[site.point_id].forEach(function(p,i){
      photoTable.rows.push([photoTable.rows.length+1].concat(preamble,[i+1,captureText(p.photo_filename),captureDate(p.uploaded_at),'','','',site.point_id,p.photo_id]));
      photoTable.links[11].push(link[0]);photoTable.links[12].push(link[1]);photoTable.images.push(capturePreview(p.photo_token,false));
    });
    mafBy[site.point_id].forEach(function(m){
      mafTable.rows.push([mafTable.rows.length+1].concat(preamble,[captureText(m.type_label),Number(m.quantity||0),CONDITIONS[m.condition]||captureText(m.condition),captureText(m.comment),'',captureDate(m.updated_at),'','',site.point_id,m.maf_id]));
      mafTable.links[13].push(link[0]);mafTable.links[14].push(link[1]);mafTable.images.push(capturePreview(m.photo_token,true));
    });
  });
  return {summary:summary,all:siteTable(data.sites),
    work:siteTable(data.sites.filter(function(s){return s.state==='work';})),
    submitted:siteTable(data.sites.filter(function(s){return s.state==='submitted';})),
    accepted:siteTable(data.sites.filter(function(s){return s.state==='accepted';})),
    rework:siteTable(data.sites.filter(function(s){return s.state==='rework';})),photos:photoTable,maf:mafTable};
}
function captureLog(status,data,note){
  captureEnsureSheet('log').appendRow([captureDate(new Date()),status,data?data.sites.length:0,data?data.photos.length:0,data?data.maf.length:0,captureText(note||'')]);
}
function syncSheet(){
  var lock=LockService.getDocumentLock();
  if(!lock.tryLock(30000))return;
  var data=null;
  try{
    // Получаем и проверяем полный снимок прежде, чем менять действующие листы.
    data=fetchJson('/workflow/sheet.json');
    var dict=fetchJson('/dictionaries'),out=captureBuild(data,dict);
    ['all','work','submitted','accepted','rework'].forEach(function(key){captureWrite(key,out[key].rows,out[key].links);});
    captureWrite('photos',out.photos.rows,out.photos.links,10,out.photos.images);
    captureWrite('maf',out.maf.rows,out.maf.links,11,out.maf.images);
    captureWrite('summary',out.summary,{});
    captureLog('OK',data,'Срез сервера: '+captureDate(data.generated_at));
  }catch(e){captureLog('Ошибка',null,String(e&&e.message||e).slice(0,350));throw e;}
  finally{lock.releaseLock();}
}
