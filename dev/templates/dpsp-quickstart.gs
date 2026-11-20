/**
 * ДП/СП и МАФ — быстрый запуск нового цикла, 17.11.2026.
 * Основа: Hainox/karta-sao, dev/templates/dpsp-sheet.gs (merge adf69905).
 *
 * ЦЕЛЕВАЯ КНИГА: «ПРЕФА ДП И СП», 1l2qhV6Ii5gVGnikhsQDUHAUi8cL8SNiB5IwLFGr0Rjs.
 * Предыдущая версия писала в «ДЕТ И СПОРТ» (1O-mnEBYEJ0wgWEkv2nx1qy77-bCjtKYUp2swt3bBnxQ),
 * потому что там был жёстко задан DPSP_BOOK_ID; запуск из рабочей книги при этом
 * блокировался проверкой в START_DPSP.
 *
 * Изменения 17.11.2026:
 *   1. DPSP_BOOK_ID указывает на рабочую книгу «ПРЕФА ДП И СП».
 *   2. START_DPSP не падает при запуске из другой книги: пишет предупреждение
 *      в лог, данные всё равно идут в книгу из DPSP_BOOK_ID.
 *   3. Защита от таймаутов: перед записью считается отпечаток каждой таблицы.
 *      Если данные не изменились, лист не перезаписывается.
 *   4. Шапка, ширины и скрытые колонки оформляются один раз, а не каждый прогон.
 *   5. Пункт меню «Перезаписать все листы» сбрасывает отпечатки.
 *   6. Колонка «% отработано» в «Свод · новый цикл» красится по той же шкале,
 *      что в прежней таблице: 100 % зелёный, 80 % светло-зелёный, 60 % жёлтый,
 *      40 % оранжевый, ниже 20 % тёмно-красный.
 *
 * 1. Сохраните прежний Код.gs в отдельный файл.
 * 2. Замените ВСЁ содержимое Код.gs этим файлом и сохраните.
 *    Не добавляйте рядом со старым кодом: дубли функций недопустимы.
 * 3. Свойства SAO_LOGIN / SAO_PASSWORD / SAO_TOKEN остаются в текущем проекте.
 *    При переносе кода в другой проект их нужно задать заново.
 * 4. Выберите START_DPSP и нажмите «Выполнить», разрешите доступ Google.
 *
 * Один запуск: проверка книги и авторизации → полный срез API → проверка
 * связей → новые вкладки → загрузка → триггер на каждые 10 минут.
 * Старые листы, ручная сверка, фотографии и решения на сервере не меняются.
 * Скрипт обращается к API только для чтения и авторизации.
 * Триггер создан ≠ триггер уже выполнился. Следующий OK в новом журнале
 * подтверждает следующий успешный запуск; способ запуска указан в комментарии.
 */
var DPSP_BOOK_ID = '1l2qhV6Ii5gVGnikhsQDUHAUi8cL8SNiB5IwLFGr0Rjs';
var CFG = {
  api: 'https://obhod-sao.ru/photo-api/object-photo-points/dpsp',
  apiLogin: 'https://obhod-sao.ru/photo-api/auth/login'
};
var __dpspBook = null;
function captureBook() {
  if (!__dpspBook) __dpspBook = SpreadsheetApp.openById(DPSP_BOOK_ID);
  return __dpspBook;
}
function captureToast(text, seconds) {
  try { captureBook().toast(text, 'ДП/СП', seconds || 8); }
  catch (e) { console.log(text); }
}
function START_DPSP() {
  var book = captureBook();
  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active || active.getId() !== DPSP_BOOK_ID) {
    console.log('Запуск из книги «' + (active ? active.getName() : 'без таблицы') + '». ' +
      'Данные пишутся в «' + book.getName() + '» (' + DPSP_BOOK_ID + ').');
  }
  credentials();
  var result = syncSheet();
  // При исключении или занятой блокировке выполнение до этой строки не дойдёт.
  installTriggers();
  console.log('Готово. Книга: ' + book.getName() + '. Площадок: ' + result.sites +
    '; обзорных фото: ' + result.photos + '; МАФ: ' + result.maf +
    '; обновлено листов: ' + result.sheets + '. Автообновление каждые 10 минут включено.');
  captureToast('Данные загружены. Автообновление: 10 минут.', 10);
  return result;
}
function onOpen() {
  SpreadsheetApp.getUi().createMenu('ДП/СП · новый цикл')
    .addItem('Запустить всё', 'START_DPSP')
    .addItem('Обновить сейчас', 'syncSheet')
    .addItem('Перезаписать все листы', 'resetHashes')
    .addItem('Выключить автообновление', 'removeTriggers').addToUi();
}
function onEdit(e) { /* Прежняя автоматическая пересборка сверки отключена. */ }
function installTriggers() {
  // Сначала создаём новый: ошибка создания не уничтожит существующий триггер.
  var previous = ScriptApp.getProjectTriggers().filter(function(t) {
    return t.getHandlerFunction() === 'syncSheet';
  });
  ScriptApp.newTrigger('syncSheet').timeBased().everyMinutes(10).create();
  previous.forEach(function(t) { ScriptApp.deleteTrigger(t); });
}
function removeTriggers() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'syncSheet') ScriptApp.deleteTrigger(t);
  });
}

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
  if (!creds.token) renewToken(creds);
  for (var attempt = 0; attempt < 2; attempt += 1) {
    var response = UrlFetchApp.fetch(CFG.api + path, {
      headers: { Authorization: 'Bearer ' + creds.token }, muteHttpExceptions: true
    });
    if ((response.getResponseCode() === 401 || !creds.token) && attempt === 0) { renewToken(creds); continue; }
    if (response.getResponseCode() !== 200) {
      throw new Error('API ' + path + ': HTTP ' + response.getResponseCode());
    }
    return JSON.parse(response.getContentText());
  }
  throw new Error('HTTP 401 после обновления токена');
}


function ensureCapacity(sheet, rows) {
  if (sheet.getMaxRows() < rows) sheet.insertRowsAfter(sheet.getMaxRows(), rows - sheet.getMaxRows());
}


var CONDITIONS = {ok:'Исправно',repair:'Требует ремонта',broken:'Неисправно'};
function kindLabel(kind) { return kind === 'dp' ? 'ДП' : 'СП'; }

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
  var book=captureBook();
  var sheet=book.getSheetByName(CAPTURE.names[key]);
  // Быстрый путь: лист уже создан и шапка на месте — оформление не повторяем.
  if (sheet && sheet.getMaxColumns()>=spec.headers.length &&
      sheet.getRange(1,1,1,spec.headers.length).getValues()[0].join('|')===spec.headers.join('|')) {
    return sheet;
  }
  if (!sheet) sheet=book.insertSheet(CAPTURE.names[key]);
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
  captureToast('Новые листы готовы. Старые листы сохранены.',6);
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

/**
 * Цветовая шкала для колонки «% отработано» в «Свод · новый цикл».
 * Пороги и цвета повторяют прежнюю таблицу: 100 % — зелёный, 80–99 % —
 * светло-зелёный, 60–80 % — жёлтый, 40–60 % — оранжевый, ниже — красные.
 * Повторный запуск заменяет только правила на этой колонке.
 */
function captureApplyPercentColors(rowCount) {
  var sheet=captureBook().getSheetByName(CAPTURE.names.summary);
  if(!sheet)return;
  var lastRow=Math.max(2,Number(rowCount)||2)+1;
  var range=sheet.getRange(2,8,lastRow-1,1);
  var bands=[
    {min:0.9995,color:'#00B050'},{min:0.8,color:'#A5D6A7'},{min:0.6,color:'#FFF59D'},
    {min:0.4,color:'#FF8A65'},{min:0.2,color:'#E53935'}
  ];
  var rules=sheet.getConditionalFormatRules().filter(function(rule){
    return !rule.getRanges().some(function(existing){
      return !(existing.getLastRow()<range.getRow()||existing.getRow()>range.getLastRow()
        ||existing.getLastColumn()<range.getColumn()||existing.getColumn()>range.getLastColumn());
    });
  });
  bands.forEach(function(band){
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenNumberGreaterThanOrEqualTo(band.min).setBackground(band.color).setRanges([range]).build());
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenNumberLessThan(0.2).setBackground('#B71C1C').setRanges([range]).build());
  sheet.setConditionalFormatRules(rules);
}

/* ---------- Отпечатки таблиц: не перезаписываем то, что не изменилось ---------- */

var SYNC_HASH_KEY = 'DPSP_SYNC_HASHES';

function syncFingerprint(rows) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5,
    JSON.stringify(rows), Utilities.Charset.UTF_8);
  return Utilities.base64Encode(digest);
}
function syncHashes() {
  try {
    return JSON.parse(PropertiesService.getScriptProperties().getProperty(SYNC_HASH_KEY) || '{}');
  } catch (e) {
    return {};
  }
}
function resetHashes() {
  PropertiesService.getScriptProperties().deleteProperty(SYNC_HASH_KEY);
  console.log('Отпечатки сброшены: следующая синхронизация перезапишет все листы.');
  captureToast('Отпечатки сброшены. Следующий запуск перезапишет все листы.', 8);
}

function syncSheet(event){
  var lock=LockService.getScriptLock();
  if(!lock.tryLock(30000))throw new Error('Синхронизация уже выполняется. Повторите позже.');
  var data=null;
  try{
    // Получаем и проверяем полный снимок прежде, чем менять действующие листы.
    data=fetchJson('/workflow/sheet.json');
    var dict=fetchJson('/dictionaries'),out=captureBuild(data,dict);
    if (!data.sites.length) throw new Error('API вернул 0 площадок. Запись остановлена; проверьте роль учётной записи.');
    var tables={
      all:{rows:out.all.rows,write:function(){captureWrite('all',out.all.rows,out.all.links);}},
      work:{rows:out.work.rows,write:function(){captureWrite('work',out.work.rows,out.work.links);}},
      submitted:{rows:out.submitted.rows,write:function(){captureWrite('submitted',out.submitted.rows,out.submitted.links);}},
      accepted:{rows:out.accepted.rows,write:function(){captureWrite('accepted',out.accepted.rows,out.accepted.links);}},
      rework:{rows:out.rework.rows,write:function(){captureWrite('rework',out.rework.rows,out.rework.links);}},
      photos:{rows:out.photos.rows,write:function(){captureWrite('photos',out.photos.rows,out.photos.links,10,out.photos.images);}},
      maf:{rows:out.maf.rows,write:function(){captureWrite('maf',out.maf.rows,out.maf.links,11,out.maf.images);}},
      summary:{rows:out.summary,write:function(){captureWrite('summary',out.summary,{});}}
    };
    var previous=syncHashes(),next={},written=[];
    Object.keys(tables).forEach(function(key){
      var signature=syncFingerprint(tables[key].rows);
      next[key]=signature;
      var sheet=captureBook().getSheetByName(CAPTURE.names[key]);
      if(!sheet||previous[key]!==signature){tables[key].write();written.push(key);}
    });
    // Покраска процентов не должна срывать загрузку данных.
    try { captureApplyPercentColors(out.summary.length); }
    catch(formatError){ console.error('Не удалось покрасить проценты: '+formatError); }
    // Отпечатки сохраняются только после успешной записи: при сбое следующий
    // запуск повторит запись изменённых листов.
    PropertiesService.getScriptProperties().setProperty(SYNC_HASH_KEY,JSON.stringify(next));
    SpreadsheetApp.flush();
    captureLog('OK',data,'Запуск: '+(event&&event.triggerUid?'триггер':'вручную')+
      '; обновлено листов: '+(written.length?written.join(', '):'нет (данные не изменились)')+
      '; срез сервера: '+captureDate(data.generated_at));
    return {sites:data.sites.length,photos:data.photos.length,maf:data.maf.length,sheets:written.length};
  }catch(e){
    try { captureLog('Ошибка',null,String(e&&e.message||e).slice(0,350)); }
    catch(logError) { console.error('Не удалось записать журнал ошибки.'); }
    throw e;
  }
  finally{lock.releaseLock();}
}
