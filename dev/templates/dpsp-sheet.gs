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
 *   3. Перезагрузить таблицу → меню «ДП/СП · Оцифровка» → «Собрать структуру».
 *   4. «Обновить сейчас» — залить данные. Затем «Включить автообновление (10 мин)».
 *
 * Структура: площадка — родительский объект (лист «Площадки»), МАФ — дочерние
 * (лист «МАФ», связаны по site_id). «Сверка» — по площадке, с решениями.
 */

var CFG = {
  api: 'https://obhod-sao.ru/photo-api/object-photo-points/dpsp',
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
    .addItem('Собрать структуру', 'installSheets')
    .addItem('Обновить сейчас', 'syncSheet')
    .addItem('Пересобрать «Сверку»', 'refreshCrossMenu')
    .addSeparator()
    .addItem('Покрасить «% оцифровки»', 'applyPercentColors')
    .addItem('Включить автообновление (10 мин)', 'installTriggers')
    .addItem('Выключить автообновление', 'removeTriggers')
    .addToUi();
}

// Фильтры B1/B2 на «Сверке» пересобирают вид сразу после изменения.
function onEdit(e) {
  var range = e && e.range;
  if (!range) return;
  if (range.getSheet().getName() !== CFG.sheets.cross) return;
  if (range.getRow() > 2 || range.getColumn() !== 2) return;
  rebuildCross({ sites: readSitesSheet(), maf: readMafSheet() }, range.getSheet());
}

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

function thumb(tokenValue) {
  return tokenValue ? CFG.api + '/photo-thumb/' + tokenValue + '.jpg' : '';
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
  var sheet = ensureSheet(CFG.sheets.cross, null, [40, 130, 60, 300, 110, 340, 80, 130, 150, 130, 170, 220, 170, 130, 0, 90], [15]);
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

function syncSheet() {
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
      thumb(site.photo_token)
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
      site.photo_url ? '=IMAGE(VLOOKUP($O' + row + ';Площадки!$A:$M;13;FALSE);4;160;120)' : '',
      past.decision || '—', past.reason || '', past.comment || '',
      past.who || '', past.when || '', site.site_id,
      mapUrl ? '=HYPERLINK("' + mapUrl + '";"На карте")' : ''
    ]);
    if ((past.decision || '—') !== '—' && !past.who && !past.when) stamps.push(row);
  });
  writeTable(sheet, rows, 8, 7);
  if (formulas.length) {
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
