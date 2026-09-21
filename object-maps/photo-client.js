import {
  accountScope, accuracyVerdict, bandNote, bandText, boundaryNote, buildCoverageIndex,
  buildQueue, canExport, coverageBand, coverageCounterText, coverageFor, coverageLabel, coveragePercent,
  districtBoundaries, filterRecords, formatCoordinates, formatMeters, geoStatusText, gpsDistanceLabel,
  groupLabel, groupValues, isAutodorAccount, isAutodorHolder, photoDetailRows, photoRequirementFor,
  reportSummaryRows, scopedDistricts, statusText,
} from './photo-model.js';
import { errorText } from './photo-messages.js';

const API_FALLBACK = 'https://obhod-sao.ru/photo-api';
const TOKEN_KEY = 'sao-photo-service-token';
const SCENARIO_KEY = 'sao-photo-service-scenario';
const PERFORMER_KEY = 'sao-photo-service-performer';
const LIST_CAP = 250;
// С какой выборки карта начинает группировать точки в кластеры.
const CLUSTER_FROM_MARKERS = 1000;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
// Сервис принимает только эти форматы (CHECK в БД и проверка MIME при разборе
// multipart). HEIC/HEIF раньше обещались в подсказке, но всегда отклонялись —
// район видел «unsupported_image» после съёмки с iPhone.
const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];

// Цвет отвечает на вопрос «что делать»: красный — снимать с нуля, жёлтый — доснять
// кадр, синий — ждать приёмку, зелёный — принято. Порядок задаёт порядок в легенде.
const STATUS_COLOR = { done: '#0c7a5a', pending: '#2f6fb0', incomplete: '#e0a800', empty: '#b4552f' };

const state = {
  manifest: null,
  entry: null,
  dataset: null,
  coverage: new Map(),
  summary: null,
  // Полный список районов для фильтра: под суженной сводкой сервер отдаёт один район.
  districtOptions: null,
  // Вид оцифровки для бокового дашборда: «all» или тип объекта.
  boardType: 'all',
  // Смена района перестраивает вид карты: иначе найденные точки остаются за кадром.
  fitDistrict: false,
  // Дневной отчёт по продуктивности: только для префектуры, приходит одним запросом.
  daily: null,
  user: null,
  token: '',
  // Исполнитель один на всю страницу: поле в карточке и поле в очереди раньше
  // жили отдельно, и текст мог требовать «укажите исполнителя» там, где он уже введён.
  performer: '',
  scenario: 'register',
  queueIndex: 0,
  selected: null,
  // На точку можно выбрать столько кадров, сколько требует вид объекта: у
  // пешеходного перехода их два, у остановки и подъезда — один.
  files: [],
  previewUrl: '',
  previewUrls: [],
  gps: null,
  idempotencyKey: '',
  idempotencySignature: '',
  sendState: 'idle',
  objectUrls: [],
  map: null,
  pointLayer: null,
  // Режим слоя точек: нужны ли кластеры на текущей выборке.
  clusterizeMode: null,
  boundaryLayer: null,
  boundarySignature: '',
  districts: null,
  mapReady: false,
  indexById: new Map(),
  lastFocused: null,
  dataCache: new Map(),
  referencePoints: new Map(),
  boardAll: [],
};

const element = (id) => document.getElementById(id);
const apiBase = () => window.SAO_PHOTO_API_BASE || API_FALLBACK;

/* ------------------------------------------------------------------ session */

function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (state.token && path !== '/auth/login') headers.set('Authorization', `Bearer ${state.token}`);
  return fetch(apiBase() + path, { credentials: 'include', ...options, headers });
}

async function apiJson(path, options) {
  const response = await api(path, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const code = body?.error || '';
    // Код нужен логике (протухшая сессия), текст — человеку.
    const error = new Error(errorText(code, body?.message) || `Сервис ответил ${response.status}`);
    error.status = response.status;
    error.code = code;
    if (response.status === 401 && path !== '/auth/login') {
      error.sessionExpired = true;
      expireSession();
    }
    throw error;
  }
  return body;
}

/**
 * Сессия протухла посреди работы. Раньше метка входа продолжала показывать
 * прежнего пользователя, а каждая ручка отдельно писала «Сводка недоступна:
 * authentication_required». Теперь состояние сбрасывается один раз и понятно.
 */
function expireSession() {
  if (!state.user) return;
  rememberToken('');
  setSession(null);
  state.coverage = new Map();
  state.summary = null;
  invalidateQueue();
  renderAll();
  showToast('Сеанс истёк — войдите заново.', 'error');
}

function rememberToken(token) {
  state.token = token || '';
  try {
    if (state.token) sessionStorage.setItem(TOKEN_KEY, state.token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode without storage still works through the cookie */ }
}

function setSession(user) {
  state.user = user || null;
  const form = element('paLoginForm');
  const label = element('paSessionState');
  const logoutButton = element('paLogoutButton');
  if (user) {
    form.hidden = true;
    logoutButton.hidden = false;
    label.textContent = `${user.displayName || user.email} · ${user.district || 'префектура (САО)'}`;
  } else {
    form.hidden = false;
    logoutButton.hidden = true;
    label.textContent = 'Вход не выполнен — фото можно только просматривать';
  }
  const districtRole = user?.role === 'district_editor';
  element('paDistrictFilter').disabled = Boolean(districtRole);
  element('paDistrictFilter').closest('div').hidden = Boolean(districtRole);
  renderExports();
}

async function restoreSession() {
  try { rememberToken(sessionStorage.getItem(TOKEN_KEY) || ''); } catch { /* ignore */ }
  try {
    const body = await apiJson('/auth/me');
    setSession(body.user);
  } catch {
    if (state.token) {
      rememberToken('');
      try { const body = await apiJson('/auth/me'); setSession(body.user); return; } catch { /* stay anonymous */ }
    }
    setSession(null);
  }
}

async function submitLogin(event) {
  event.preventDefault();
  const button = element('paLoginButton');
  button.disabled = true;
  button.textContent = 'Проверяем…';
  try {
    const body = await apiJson('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login: element('paLoginInput').value, password: element('paPasswordInput').value }),
    });
    rememberToken(body.token);
    element('paPasswordInput').value = '';
    setSession(body.user);
    // Ошибку загрузки сводки нельзя перекрывать бодрым «Вход выполнен»: район
    // видел «вход выполнен», а ниже оставалось пусто и непонятно почему.
    const coverage = await refreshCoverage({ announce: false });
    showToast(
      coverage.ok ? 'Вход выполнен.' : `Вход выполнен, но сводка не загрузилась: ${coverage.error}`,
      coverage.ok ? 'info' : 'error',
    );
  } catch (error) {
    showToast(`Вход не выполнен: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Войти';
  }
}

async function submitLogout() {
  if (!state.user) return;
  try { await apiJson('/auth/logout', { method: 'POST' }); } catch { /* the local session is cleared anyway */ }
  rememberToken('');
  setSession(null);
  state.coverage = new Map();
  state.summary = null;
  invalidateQueue();
  renderAll();
  showToast('Вы вышли из фотослужбы.');
}

/* -------------------------------------------------------------- toast/state */

let toastTimer = null;
let lastErrorAt = 0;
function showToast(message, kind = 'info') {
  const now = Date.now();
  // Сообщение об успехе не должно затирать ошибку: пользователь увидит «Всё
  // хорошо», а причина сбоя исчезнет с экрана через миллисекунды.
  if (kind !== 'error' && now - lastErrorAt < 6000) return;
  if (kind === 'error') lastErrorAt = now;
  const toast = element('paToast');
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.dataset.visible = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.dataset.visible = 'false'; }, kind === 'error' ? 9000 : 5200);
}

function setSendState(kind, text) {
  state.sendState = kind;
  for (const id of ['paUploadState', 'paQueueState']) {
    const node = element(id);
    if (!node) continue;
    node.dataset.state = kind;
    node.textContent = text;
  }
  updateUploadButton();
}

/* -------------------------------------------------------------------- data */

async function loadManifest() {
  const response = await fetch('data/manifest.json', { cache: 'no-cache' });
  if (!response.ok) throw new Error('Не удалось прочитать описание наборов данных.');
  state.manifest = await response.json();
}

// District polygons come from the atlas file next to object-maps/.
async function loadDistrictBoundaries() {
  try {
    const response = await fetch('../districts.geojson', { cache: 'force-cache' });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function loadDataset(entry) {
  const response = await fetch(`data/${entry.file}`, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Не удалось загрузить набор «${entry.title}».`);
  const dataset = await response.json();
  state.indexById = new Map(dataset.records.map((record, index) => [record.id, index]));
  return dataset;
}

async function selectDataset(key, { keepScenario = true } = {}) {
  const entry = state.manifest.datasets.find((dataset) => dataset.key === key) || state.manifest.datasets[0];
  state.entry = entry;
  document.title = `${entry.title} — фотофиксация САО`;
  element('paTitle').textContent = entry.title;
  element('paSubtitle').textContent = `${entry.subtitle} · набор ${state.manifest.sourceDate} (${state.manifest.sourceVersion})`;
  element('paList').replaceChildren();
  element('paListCount').textContent = 'Загружаем объекты…';
  applyFileInputMode();
  if (!state.dataCache.has(key)) state.dataCache.set(key, await loadDataset(entry));
  state.dataset = state.dataCache.get(key);
  state.queueIndex = 0;
  invalidateQueue();
  renderDatasetTabs();
  fillGroupFilter();
  buildMap();
  await refreshCoverage();
  if (!keepScenario) setScenario('register');
}

/**
 * Форма берёт столько кадров, сколько требует вид объекта. Пешеходному переходу
 * нужны два снимка — оба направления, — поэтому там включается выбор нескольких
 * файлов; у остановки и подъезда камера остаётся с одним кадром.
 */
function applyFileInputMode() {
  const multiple = photoRequirementFor(state.entry?.objectType) > 1;
  const queueLabel = element('paQueueFileLabel');
  if (queueLabel) queueLabel.textContent = multiple ? 'Выбрать фото (2)' : 'Сделать фото';
  const fileLabel = element('paFileLabel');
  if (fileLabel) {
    fileLabel.textContent = multiple
      ? 'Фотографии (JPEG, PNG или WEBP) — нужны 2: оба направления перехода'
      : 'Фотография (JPEG, PNG или WEBP)';
  }
  for (const id of ['paFile', 'paQueueFile']) {
    const input = element(id);
    if (!input) continue;
    input.multiple = multiple;
    if (multiple) input.removeAttribute('capture');
    else input.setAttribute('capture', 'environment');
  }
}

function renderDatasetTabs() {
  const nav = element('paDatasets');
  nav.replaceChildren();
  for (const entry of state.manifest.datasets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pa-dataset';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(entry.key === state.entry.key));
    button.textContent = `${entry.title} · ${entry.records.toLocaleString('ru-RU')}`;
    button.addEventListener('click', () => {
      if (entry.key === state.entry.key) return;
      selectDataset(entry.key).catch((error) => showToast(error.message, 'error'));
    });
    nav.appendChild(button);
  }
}

function fillGroupFilter() {
  const select = element('paGroupFilter');
  const current = select.value;
  select.replaceChildren(new Option('Все', ''));
  for (const group of groupValues(state.dataset.records)) select.appendChild(new Option(group, group));
  if ([...select.options].some((option) => option.value === current)) select.value = current;
  element('paGroupLabel').textContent = groupLabel(state.dataset);
}

async function refreshCoverage({ announce = true } = {}) {
  if (!state.user) {
    state.coverage = new Map();
    state.summary = null;
    invalidateQueue();
    renderAll();
    return { ok: true, empty: true };
  }
  const district = requestedDistrict();
  const query = district ? `?district=${encodeURIComponent(district)}` : '';
  try {
    state.summary = await apiJson(`/reports/summary${query}`);
    state.coverage = buildCoverageIndex(state.summary);
    if (!district) state.boardAll = state.summary.byDistrict || [];
    fillDistrictFilter();
    // День показываем только префектуре: у района нет ни выгрузок, ни сводки по округу.
    if (canExport(state.user)) {
      try { state.daily = await apiJson('/reports/daily'); } catch { state.daily = null; }
    } else {
      state.daily = null;
    }
  } catch (error) {
    state.coverage = new Map();
    state.summary = null;
    // Протухшую сессию уже объяснил expireSession — второй текст не нужен.
    if (announce && !error.sessionExpired) showToast(`Сводка недоступна: ${error.message}`, 'error');
    invalidateQueue();
    renderAll();
    return { ok: false, error: error.message, empty: false };
  }
  invalidateQueue();
  renderAll();
  return { ok: true, empty: !Number(state.summary?.overall?.totalObjects) };
}

function fillDistrictFilter() {
  if (state.user?.role === 'district_editor' || !state.summary) return;
  const select = element('paDistrictFilter');
  const current = select.value;
  // Полный список районов запоминаем, когда сводка не сужена: под фильтром района
  // сервер отдаёт только его, и без этого из списка пропадали все остальные.
  if (!requestedDistrict()) {
    state.districtOptions = [...new Set((state.summary.objects || []).map((object) => object.district).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, 'ru'));
  }
  select.replaceChildren(new Option('Весь САО', ''));
  for (const district of state.districtOptions || []) select.appendChild(new Option(district, district));
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

/* ---------------------------------------------------------------- rendering */

function renderAll() {
  renderSummary();
  renderDashboard();
  renderList();
  renderMapObjects();
  // Смена района — смена области просмотра: без этого точки остаются за кадром,
  // и кажется, что фильтр ничего не нашёл.
  renderBoundaries({ fit: state.fitDistrict === true });
  state.fitDistrict = false;
  renderQueue();
}

// Виды оцифровки для бокового дашборда: смотреть охват можно не только по всем
// объектам сразу, но и по каждому виду отдельно — у района они идут по-разному.
const BOARD_TYPES = Object.freeze([
  { key: 'all', label: 'Все виды' },
  { key: 'stop', label: 'Остановки' },
  { key: 'pp', label: 'Переходы' },
  { key: 'entrance', label: 'Подъезды' },
]);

/**
 * Строки дашборда по выбранному виду оцифровки. Считаем отметки (точки), а не
 * объекты: у одного перехода точек бывает несколько десятков, а в сводке на штаб
 * единица учёта та же — иначе панель и сводка показывают разные проценты по
 * одному и тому же району. Район строки — по правилу отчётов: объекты «АвД САО»
 * и «ДЭУ» идут строкой владельца, а не районом, где стоят.
 */
function boardRowsByType(type) {
  const objects = state.summary?.objects || [];
  if (type === 'all') return state.summary?.byDistrict || [];
  const grouped = new Map();
  for (const object of objects) {
    if (object.objectType !== type) continue;
    const district = !object.district || isAutodorHolder(object.balanceHolder) ? 'АвД САО' : object.district;
    const row = grouped.get(district) || { district, totalPoints: 0, coveredPoints: 0 };
    row.totalPoints += Number(object.sourcePointCount) || 0;
    row.coveredPoints += Number(object.coveredPoints) || 0;
    grouped.set(district, row);
  }
  return [...grouped.values()].sort((left, right) => {
    if ((left.district === 'АвД САО') !== (right.district === 'АвД САО')) {
      return left.district === 'АвД САО' ? 1 : -1;
    }
    return (pointsPercent(right) - pointsPercent(left)) || left.district.localeCompare(right.district, 'ru');
  });
}

/**
 * Процент по закрытым отметкам — та же единица, что в сводке на штаб. Считать
 * по объектам нельзя: «все объекты с фото» и «половина отметок закрыта» — это
 * одно и то же состояние, а числа выглядят как противоречие.
 */
function pointsPercent(row) {
  const plan = Number(row?.totalPoints) || 0;
  if (!plan) return 0;
  return Math.round(((Number(row.coveredPoints) || 0) / plan) * 100);
}

/**
 * Доска округа нужна префектуре: район и так видит только себя. Когда префектура
 * проваливается в один район, показываем сохранённый срез по всему округу.
 */
function boardDistricts() {
  if (!canExport(state.user)) return [];
  const rows = boardRowsByType(state.boardType);
  if (state.boardType !== 'all') return rows;
  if (requestedDistrict()) return state.boardAll?.length ? state.boardAll : rows;
  return rows;
}

function boardRow(district) {
  // Строка «АвД САО» — это объём владельца, а не один район: его объекты и объекты
  // «ДЭУ» стоят по всему округу, поэтому такой строкой панель не фильтруется. Она
  // идёт последней, как её отдаёт сервер, и остаётся справочной, как строка «Без
  // района» раньше. Остальные строки — обычные районы с переходом в фильтр.
  const owner = isAutodorAccount(district.district);
  const row = document.createElement(owner ? 'div' : 'button');
  if (!owner) row.type = 'button';
  row.className = 'pa-board-row';
  row.setAttribute('role', 'listitem');
  if (owner) row.dataset.scope = 'owner';

  const caption = document.createElement('span');
  const name = document.createElement('span');
  name.className = 'pa-board-name';
  name.textContent = district.district;
  // Единица учёта — отметка: у перехода точек несколько, и в сводке на штаб
  // считается так же. Приёмка может подтвердить позже, но работа видна сразу.
  const percent = pointsPercent(district);
  const note = document.createElement('span');
  note.className = 'pa-board-note';
  note.textContent = `закрыто ${district.coveredPoints} из ${district.totalPoints} отметок`;
  caption.append(name, note);

  const bar = document.createElement('span');
  bar.className = 'pa-board-bar';
  bar.dataset.band = coverageBand(percent);
  const fill = document.createElement('span');
  fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  bar.appendChild(fill);

  const value = document.createElement('span');
  value.className = 'pa-board-value';
  value.textContent = `${percent} %`;

  row.append(caption, bar, value);
  if (!owner) {
    row.title = `Показать только ${district.district}`;
    row.addEventListener('click', () => {
      element('paDistrictFilter').value = district.district;
      invalidateQueue();
      state.fitDistrict = true;
      refreshCoverage();
    });
  }
  return row;
}

function renderDashboard() {
  const board = element('paDashboard');
  const list = element('paDistrictBoard');
  const districts = boardDistricts();
  // Доска округа — инструмент префектуры: району она ничего не добавляет, у него
  // своя сводка выше. Под фильтром района доска остаётся на экране даже с одной
  // строкой — иначе разрез по видам для выбранного района посмотреть нельзя.
  if (!canExport(state.user)) {
    board.hidden = true;
    list.replaceChildren();
    return;
  }
  board.hidden = false;
  renderBoardSwitch();
  list.replaceChildren();
  if (!districts.length) {
    const empty = document.createElement('p');
    empty.className = 'pa-note';
    const district = requestedDistrict();
    empty.textContent = district
      ? `У района «${district}» объектов этого вида нет.`
      : 'Объектов этого вида нет.';
    list.appendChild(empty);
    return;
  }
  for (const district of districts) list.appendChild(boardRow(district));
}

/** Переключатель видов оцифровки: «все виды» и по одному на каждый. */
function renderBoardSwitch() {
  const box = element('paBoardSwitch');
  if (!box) return;
  box.replaceChildren();
  for (const type of BOARD_TYPES) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'pa-board-chip';
    chip.textContent = type.label;
    const active = state.boardType === type.key;
    chip.setAttribute('aria-pressed', String(active));
    if (active) chip.dataset.active = 'true';
    chip.addEventListener('click', () => {
      if (state.boardType === type.key) return;
      state.boardType = type.key;
      renderDashboard();
    });
    box.appendChild(chip);
  }
}

function renderSummary() {
  const box = element('paSummary');
  box.replaceChildren();
  if (!state.summary) {
    const note = document.createElement('p');
    note.className = 'pa-note';
    note.textContent = state.user
      ? 'Сводка загружается…'
      : 'Войдите, чтобы увидеть сводку, счётчики и фотографии.';
    box.appendChild(note);
    return;
  }
  const head = document.createElement('div');
  head.className = 'pa-summary-head';
  const value = document.createElement('span');
  value.className = 'pa-summary-value';
  value.textContent = coverageLabel(state.summary.overall);
  const overviewBand = coverageBand(coveragePercent(state.summary.overall));
  const band = document.createElement('span');
  band.className = 'pa-summary-band';
  band.dataset.band = overviewBand;
  band.textContent = `${bandText(overviewBand)} — ${bandNote(overviewBand)}`;
  head.append(value, band);
  box.appendChild(head);

  // Пустая сводка не должна выглядеть как «ещё грузится»: у района может не быть
  // объектов из-за данных, а не из-за сети.
  if (state.user && !Number(state.summary.overall?.totalObjects)) {
    const note = document.createElement('p');
    note.className = 'pa-note';
    note.textContent = state.user.role === 'district_editor'
      ? `По району «${state.user.district}» объектов нет. Проверьте учётную запись или обратитесь в префектуру.`
      : 'В выбранной выборке объектов нет.';
    box.appendChild(note);
  }

  const metrics = document.createElement('dl');
  metrics.className = 'pa-metrics';
  for (const row of reportSummaryRows(state.summary).slice(0, 7)) {
    const item = document.createElement('div');
    item.className = 'pa-metric';
    const term = document.createElement('dt');
    term.textContent = row.key;
    const description = document.createElement('dd');
    description.textContent = row.value;
    item.append(term, description);
    metrics.appendChild(item);
  }
  box.appendChild(metrics);

  if (canExport(state.user) && state.daily) {
    box.appendChild(dayBlock(state.daily));
  }

  if (state.summary.unassigned && state.summary.unassigned.totalObjects > 0 && !element('paDistrictFilter').value) {
    const note = document.createElement('p');
    note.className = 'pa-unassigned';
    note.textContent = `Объектов без района: ${state.summary.unassigned.totalObjects} `
      + `(${String(state.summary.unassigned.objectsWithoutPhoto)} без фото, `
      + `${String(state.summary.unassigned.objectsWithPhoto)} с фото) — `
      + 'они учтены в строке «АвД САО» вместе с объектами владельца и «ДЭУ».';
    box.appendChild(note);
    // Привязку не меняем: объект вне полигонов — это данные источника. Но
    // префектура должна видеть, какие именно объекты остались без района.
    const list = state.summary.unassigned.objects || [];
    if (list.length) {
      const details = document.createElement('details');
      details.className = 'pa-unassigned-list';
      const summary = document.createElement('summary');
      summary.textContent = `Показать объекты без района (${list.length}`
        + `${state.summary.unassigned.totalObjects > list.length ? ` из ${state.summary.unassigned.totalObjects}` : ''})`;
      details.appendChild(summary);
      const items = document.createElement('ul');
      for (const object of list.slice(0, 20)) {
        const item = document.createElement('li');
        item.textContent = `${object.label || object.objectKey} · ${object.objectType} · точек ${object.sourcePoints}`;
        items.appendChild(item);
      }
      if (list.length > 20) {
        const rest = document.createElement('li');
        rest.textContent = `…и ещё ${list.length - 20}`;
        items.appendChild(rest);
      }
      details.appendChild(items);
      box.appendChild(details);
    }
  }
}

/**
 * Блок «День»: что сделано за московские сутки и как это выглядит рядом со
 * средним днём недели. Числа приходят одним запросом `/reports/daily`.
 */
function dayBlock(daily) {
  const box = document.createElement('div');
  box.className = 'pa-day';
  const head = document.createElement('p');
  head.className = 'pa-list-head';
  head.textContent = `Продуктивность за ${daily.date} (МСК)`;
  box.appendChild(head);

  const signed = (value) => `${value > 0 ? '+' : ''}${Number(value).toLocaleString('ru-RU')}`;
  const lines = [
    `Загружено фото: ${Number(daily.overall.uploaded).toLocaleString('ru-RU')} (${signed(daily.deltas.uploadedVsYesterday)} к вчера)`,
    `Подтверждено отметок: ${Number(daily.overall.closed).toLocaleString('ru-RU')} (${signed(daily.deltas.closedVsYesterday)} к вчера)`,
    `Работали районы: ${daily.overall.activeDistricts} из ${daily.overall.totalDistricts}, исполнителей ${daily.overall.activePerformers}`,
    `На проверке: ${Number(daily.overall.pending).toLocaleString('ru-RU')}`,
  ];
  if (daily.leaders.best.length) {
    lines.push(`Лучшие за день: ${daily.leaders.best.map((entry) => `${entry.district} (${entry.closed})`).join(', ')}`);
  }
  if (daily.leaders.silent.length) {
    lines.push(`Без загрузок: ${daily.leaders.silent.join(', ')}`);
  }
  const list = document.createElement('ul');
  for (const line of lines) {
    const item = document.createElement('li');
    item.textContent = line;
    list.appendChild(item);
  }
  box.appendChild(list);
  return box;
}

function currentRecords() {
  const scope = accountScope(state.user, state.summary);
  return filterRecords(state.dataset?.records || [], {
    query: element('paSearch').value,
    group: element('paGroupFilter').value,
    // Учётная запись района ограничена своим районом, АвД — списком своих
    // объектов из сводки, префектура идёт за фильтром на экране.
    district: state.user?.role === 'district_editor' ? scope.district : element('paDistrictFilter').value,
    objectKeys: scope.objectKeys,
    status: element('paStatusFilter').value,
    coverageIndex: state.coverage,
    objectType: state.entry.objectType,
  });
}

function rowChip(statusKey, label, pending) {
  const chip = document.createElement('span');
  chip.className = 'pa-chip';
  chip.dataset.status = statusKey;
  chip.textContent = pending > 0 && statusKey !== 'pending' ? `${label} · на проверке ${pending}` : label;
  return chip;
}

function renderList() {
  const list = element('paList');
  list.replaceChildren();
  if (!state.dataset) return;
  const filtered = currentRecords();
  const shown = filtered.slice(0, LIST_CAP);
  element('paListCount').textContent = `Показано ${shown.length.toLocaleString('ru-RU')} из ${filtered.length.toLocaleString('ru-RU')} объектов`
    + (filtered.length > LIST_CAP ? ` · первые ${LIST_CAP}` : '');
  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'pa-note';
    empty.textContent = 'Ничего не найдено.';
    list.appendChild(empty);
    return;
  }
  for (const record of shown) {
    const coverage = coverageFor(state.coverage, record, state.entry.objectType);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pa-row';
    row.setAttribute('role', 'listitem');
    const title = document.createElement('span');
    title.className = 'pa-row-title';
    title.textContent = record.label;
    const meta = document.createElement('span');
    meta.className = 'pa-row-meta';
    const where = document.createElement('span');
    where.textContent = record.group || '—';
    const counter = document.createElement('span');
    counter.textContent = coverageCounterText(coverage);
    meta.append(where, counter, rowChip(coverage.statusKey, coverage.statusLabel, coverage.pending));
    row.append(title, meta);
    row.addEventListener('click', () => openRecord(record, row));
    list.appendChild(row);
  }
}

function renderLegend() {
  const legend = element('paLegend');
  legend.replaceChildren();
  for (const [statusKey, color] of Object.entries(STATUS_COLOR)) {
    const dot = document.createElement('span');
    dot.className = 'pa-key';
    dot.style.background = color;
    const text = document.createTextNode(`${statusText(statusKey)} `);
    legend.append(dot, text);
  }
}

/* --------------------------------------------------------------------- map */

function allDistrictNames() {
  return (state.districts?.features || []).map((feature) => feature.properties.district).filter(Boolean);
}

// What the client asks the server for. A district account is scoped server side, so it
// sends no district at all and cannot widen its own scope.
function requestedDistrict() {
  return state.user?.role === 'district_editor' ? '' : element('paDistrictFilter').value;
}

function drawnDistricts() {
  return scopedDistricts(state.user, element('paDistrictFilter').value, allDistrictNames());
}

/**
 * Draw the boundary of the district in scope. A district account only ever sees its
 * own polygon, so the map itself cannot reveal neighbouring districts.
 */
function renderBoundaries({ fit = false } = {}) {
  const note = element('paBoundaryNote');
  const wanted = drawnDistricts();
  note.textContent = boundaryNote(wanted, allDistrictNames().length);
  if (!state.map || !state.districts) return;

  const signature = wanted.join('|');
  if (signature !== state.boundarySignature) {
    state.boundarySignature = signature;
    if (state.boundaryLayer) { state.map.geoObjects.remove(state.boundaryLayer); state.boundaryLayer = null; }
    const boundaries = districtBoundaries(state.districts, wanted);
    if (boundaries.length) {
      const collection = new ymaps.GeoObjectCollection();
      for (const boundary of boundaries) {
        collection.add(new ymaps.GeoObject({
          geometry: { type: 'Polygon', coordinates: boundary.rings },
          properties: { hintContent: boundary.district },
        }, {
          fillColor: 'rgba(12, 107, 83, 0.04)',
          strokeColor: '#0c6b53',
          strokeWidth: 2,
          strokeStyle: 'solid',
          // Silent so the outline never swallows a click meant for a marker.
          interactivityModel: 'default#silent',
        }));
      }
      state.boundaryLayer = collection;
      state.map.geoObjects.add(collection);
    }
    fit = true;
  }

  if (fit && state.boundaryLayer) {
    const bounds = state.boundaryLayer.getBounds();
    if (bounds) state.map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 24 });
  }
}

function buildMap() {
  renderLegend();
  const status = element('paMapStatus');
  if (!window.ymaps) {
    status.textContent = 'Не загрузился API Яндекс Карт: проверьте интернет и ограничения ключа.';
    return;
  }
  if (!state.mapReady || !state.dataset) {
    status.textContent = 'Карта загружается…';
    return;
  }
  if (!state.map) {
    state.map = new ymaps.Map('paMap', { center: [55.75, 37.61], zoom: 9, controls: ['zoomControl'] }, { suppressMapOpenBlock: true });
  }
  ensurePointLayer(false);
  renderMapObjects();
  renderBoundaries({ fit: true });
}

/**
 * Слой точек в нужном режиме. ObjectManager не меняет кластеризацию на лету,
 * поэтому при смене режима слой пересобирается с теми же точками.
 */
function ensurePointLayer(clusterize) {
  if (state.pointLayer && state.clusterizeMode === clusterize) return;
  if (state.pointLayer) state.map.geoObjects.remove(state.pointLayer);
  state.pointLayer = new ymaps.ObjectManager({ clusterize, gridSize: 64 });
  state.clusterizeMode = clusterize;
  state.pointLayer.objects.events.add('click', (event) => {
    const record = state.dataset.records[Number(event.get('objectId'))];
    if (record) openRecord(record, null);
  });
  const features = state.dataset.records.map((record, index) => ({
    type: 'Feature',
    id: index,
    geometry: { type: 'Point', coordinates: [record.lat, record.lon] },
    properties: { recordId: record.id },
    options: { preset: 'islands#circleIcon', iconColor: STATUS_COLOR.empty },
  }));
  state.pointLayer.add({ type: 'FeatureCollection', features });
  state.map.geoObjects.add(state.pointLayer);
}

function renderMapObjects() {
  if (!state.dataset || !state.map) return;
  const filtered = currentRecords();
  // Кластеры нужны только на большой выборке: району важен цвет каждой точки
  // («не хватает кадра» — жёлтая), а в кластере он не виден. На 10 000 подъездов
  // округа карта иначе пестрая и тяжёлая для телефона.
  ensurePointLayer(filtered.length > CLUSTER_FROM_MARKERS);
  const visible = new Set(filtered.map((record) => state.indexById.get(record.id)));
  state.pointLayer.setFilter((feature) => visible.has(Number(feature.id)));
  for (const record of filtered) {
    const coverage = coverageFor(state.coverage, record, state.entry.objectType);
    state.pointLayer.objects.setObjectOptions(state.indexById.get(record.id), { iconColor: STATUS_COLOR[coverage.statusKey] });
  }
  element('paMapStatus').textContent = `Показано ${filtered.length.toLocaleString('ru-RU')} из ${state.dataset.records.length.toLocaleString('ru-RU')} объектов`;
}

/* ------------------------------------------------------------------ dialog */

function addDataRows(target, rows) {
  target.replaceChildren();
  for (const row of rows) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pa-data-row';
    const key = document.createElement('div');
    key.className = 'pa-data-key';
    key.textContent = row.key;
    const value = document.createElement('div');
    value.className = 'pa-data-value';
    value.textContent = row.value == null || row.value === '' ? '—' : String(row.value);
    wrapper.append(key, value);
    target.appendChild(wrapper);
  }
}

function releaseObjectUrls() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls = [];
}

// Превью выбранных кадров живут до отправки: объектные ссылки надо освобождать,
// иначе браузер держит в памяти все снимки сессии.
function releasePreviewUrls() {
  for (const url of state.previewUrls) URL.revokeObjectURL(url);
  state.previewUrls = [];
  state.previewUrl = '';
  const preview = element('paPreview');
  if (preview) {
    preview.removeAttribute('src');
    preview.style.display = 'none';
  }
}

function resetPhotoForm() {
  state.files = [];
  state.gps = null;
  state.idempotencyKey = '';
  state.idempotencySignature = '';
  element('paFile').value = '';
  element('paComment').value = '';
  releasePreviewUrls();
  element('paGpsNote').textContent = 'GPS не обязателен: можно определить координаты кнопкой, а можно отправить фото без них — оно уйдёт на ручную проверку.';
  setSendState('idle', 'Не отправлено.');
  updateUploadButton();
}

function updateUploadButton() {
  const sendable = state.sendState !== 'sending';
  const hasFile = state.files.length > 0;
  const hasPerformer = Boolean(state.performer);

  const saveButton = element('paSave');
  if (saveButton) {
    saveButton.disabled = !(Boolean(state.user) && hasFile && sendable && hasPerformer && Boolean(state.selected));
  }
  const queueButton = element('paQueueSave');
  if (queueButton) {
    queueButton.disabled = !(Boolean(state.user) && hasFile && sendable && hasPerformer && Boolean(queueRecord()));
  }

  const note = element('paLimitNote');
  const coverage = state.selected ? coverageFor(state.coverage, state.selected, state.entry.objectType) : null;
  if (!coverage) {
    note.textContent = 'Выберите объект, чтобы добавить фото.';
    return;
  }
  const missing = [];
  if (!state.user) missing.push('войдите в фотослужбу');
  if (!hasFile) missing.push('выберите фотографию');
  if (!hasPerformer) missing.push('укажите исполнителя');
  note.textContent = `Норма на точку — ${coverage.required} фото, подтверждено ${coverage.confirmed}. `
    + (coverage.remaining > 0 ? `Осталось снять: ${coverage.remaining}. ` : 'Норма по фото набрана — лишнее уйдёт на проверку. ')
    + (missing.length
      ? `Для отправки: ${missing.join(', ')}.`
      : `Выбрано фото: ${state.files.length} из ${coverage.required}. Всё готово к отправке.`)
    + (state.gps ? '' : ' Координаты не указаны — фото уйдёт на ручную проверку.');
}

async function openRecord(record, trigger) {
  state.selected = record;
  state.lastFocused = trigger || document.activeElement;
  setPanelOpen(false);
  const coverage = coverageFor(state.coverage, record, state.entry.objectType);
  element('paDialogTitle').textContent = record.label;
  element('paDialogSubtitle').textContent = `${record.group || '—'} · ${record.id}`;
  const statusLine = element('paDialogStatus');
  statusLine.replaceChildren(rowChip(coverage.statusKey, coverage.statusLabel, coverage.pending));
  const counter = document.createElement('span');
  counter.className = 'pa-chip';
  counter.textContent = coverageCounterText(coverage);
  statusLine.appendChild(counter);
  const rows = [{ key: 'Координаты на карте', value: formatCoordinates(record.lat, record.lon) }];
  for (const [key, value] of Object.entries(record.properties || {})) {
    if (value !== null && value !== undefined && value !== '') rows.push({ key, value });
  }
  addDataRows(element('paDialogData'), rows);
  resetPhotoForm();
  element('paPerformer').value = state.performer || readPerformer();
  const dialog = element('paDialog');
  if (!dialog.open) dialog.showModal();
  await renderGallery(record);
  element('paFile').focus({ preventScroll: true });
}

function closeRecord() {
  const dialog = element('paDialog');
  if (dialog.open) dialog.close();
  releaseObjectUrls();
  state.selected = null;
  resetPhotoForm();
  if (state.lastFocused && document.contains(state.lastFocused)) state.lastFocused.focus();
}

async function loadPhotoUrl(photoId) {
  const response = await api(`/photos/${encodeURIComponent(photoId)}/content`);
  if (!response.ok) throw new Error('Файл недоступен');
  const url = URL.createObjectURL(await response.blob());
  state.objectUrls.push(url);
  return url;
}

async function renderGallery(record) {
  const gallery = element('paGallery');
  gallery.replaceChildren();
  releaseObjectUrls();
  const storedDownloads = new Map();
  if (!state.user) {
    gallery.textContent = 'Войдите, чтобы увидеть фотографии объекта.';
    return;
  }
  let photos = [];
  try {
    const body = await apiJson(`/photos?datasetId=${encodeURIComponent(state.entry.datasetId)}&sourceId=${encodeURIComponent(record.id)}`);
    photos = body.photos || [];
  } catch (error) {
    gallery.textContent = `Не удалось прочитать фотографии: ${error.message}`;
    return;
  }
  if (!photos.length) {
    gallery.textContent = 'Для объекта ещё нет фотографий.';
    return;
  }
  for (const raw of photos) {
    const card = document.createElement('article');
    card.className = 'pa-photo';
    const image = document.createElement('img');
    image.alt = `Фотофиксация объекта ${record.label}`;
    const body = document.createElement('div');
    body.className = 'pa-photo-body';
    const list = document.createElement('dl');
    for (const row of photoDetailRows(raw)) {
      const term = document.createElement('dt');
      term.textContent = row.key;
      const value = document.createElement('dd');
      value.textContent = row.value;
      list.append(term, value);
    }
    body.appendChild(list);

    const actions = document.createElement('div');
    actions.className = 'pa-photo-actions';
    // Downloading a photo file is an export, so only the prefecture gets the link.
    if (canExport(state.user)) {
      const download = document.createElement('a');
      download.className = 'pa-btn';
      download.textContent = 'Скачать фото';
      actions.appendChild(download);
      storedDownloads.set(raw.id, download);
    }
    const reference = document.createElement('label');
    reference.className = 'pa-reference';
    const referenceBox = document.createElement('input');
    referenceBox.type = 'checkbox';
    referenceBox.disabled = state.user.role !== 'prefecture_admin';
    reference.append(referenceBox, document.createTextNode(' эталонное'));
    if (state.user.role === 'prefecture_admin') {
      const confirm = document.createElement('button');
      confirm.type = 'button';
      confirm.className = 'pa-btn';
      confirm.textContent = 'Подтвердить';
      confirm.addEventListener('click', () => reviewPhoto(raw.id, 'confirmed', referenceBox.checked, record));
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'pa-btn';
      reject.textContent = 'Отклонить';
      reject.addEventListener('click', () => reviewPhoto(raw.id, 'rejected', referenceBox.checked, record));
      actions.append(confirm, reject);
    }
    // Пока приёмка не подтвердила кадр, район отзывает его сам: раньше район не
    // мог убрать фото, загруженное по ошибке, и ждал префектуру.
    if (raw.reviewStatus === 'pending_review') {
      const withdraw = document.createElement('button');
      withdraw.type = 'button';
      withdraw.className = 'pa-btn';
      withdraw.textContent = 'Отозвать фото';
      withdraw.addEventListener('click', () => withdrawPhoto(raw.id, record, withdraw));
      actions.appendChild(withdraw);
    }
    body.append(actions, reference);
    card.append(image, body);
    gallery.appendChild(card);

    loadPhotoUrl(raw.id).then((url) => {
      image.src = url;
      const download = storedDownloads.get(raw.id);
      if (download) {
        download.href = url;
        download.download = raw.original_filename || raw.originalFilename || 'photo.jpg';
      }
    }).catch(() => {
      image.alt = 'Файл фотографии недоступен';
      image.style.background = '#f1f3ef';
    });
  }
}

async function reviewPhoto(photoId, status, isReference, record) {
  try {
    const reason = status === 'rejected' ? window.prompt('Укажите причину возврата на доработку:', '')?.trim() : '';
    if (status === 'rejected' && !reason) {
      showToast('Укажите причину возврата на доработку.', 'error');
      return;
    }
    await apiJson(`/photos/${encodeURIComponent(photoId)}/review`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, isReference, reason }),
    });
    showToast(status === 'confirmed' ? 'Фиксация подтверждена.' : 'Фиксация отклонена.');
    await refreshCoverage();
    if (record) await renderGallery(record);
  } catch (error) {
    showToast(`Не удалось изменить фиксацию: ${error.message}`, 'error');
  }
}

/** Мягкий отзыв своего кадра: подтверждённое приёмкой фото отозвать нельзя. */
async function withdrawPhoto(photoId, record, button) {
  const confirmed = window.confirm('Отозвать это фото? Оно исчезнет из галереи и счётчиков района.');
  if (!confirmed) return;
  button.disabled = true;
  try {
    await apiJson(`/photos/${encodeURIComponent(photoId)}/withdraw`, { method: 'POST' });
    showToast('Фото отозвано.');
    await refreshCoverage();
    if (record) await renderGallery(record);
  } catch (error) {
    showToast(`Не удалось отозвать фото: ${error.message}`, 'error');
    button.disabled = false;
  }
}

/* ------------------------------------------------------------------ upload */

function newIdempotencyKey() {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// One key per (object, file) attempt so a retry after a timeout replays the same
// upload instead of creating a second record on the server.
function idempotencyKeyFor(record, file) {
  const signature = `${record.id}|${file.name}|${file.size}|${file.lastModified || 0}`;
  if (state.idempotencySignature !== signature || !state.idempotencyKey) {
    state.idempotencySignature = signature;
    state.idempotencyKey = newIdempotencyKey();
  }
  return state.idempotencyKey;
}

function isSupportedFile(file) {
  const mime = String(file.type || '').toLowerCase();
  const extension = String(file.name || '').split('.').pop().toLowerCase();
  return SUPPORTED_TYPES.includes(mime)
    || ((!mime || mime === 'application/octet-stream') && SUPPORTED_EXTENSIONS.includes(extension));
}

function isHeic(file) {
  return /^image\/hei[cf]/.test(String(file.type || '').toLowerCase()) || /\.(heic|heif)$/i.test(file.name || '');
}

function compressImage(file) {
  if (typeof createImageBitmap !== 'function' || isHeic(file)) return Promise.resolve(file);
  return createImageBitmap(file).then((bitmap) => new Promise((resolve) => {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) { bitmap.close(); resolve(file); return; }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', 0.84);
  })).catch(() => file);
}

// The report embeds previews, never the originals: embedding every original would
// produce a workbook of several hundred megabytes.
const THUMBNAIL_MAX_EDGE = 320;

function makeThumbnail(file) {
  if (typeof createImageBitmap !== 'function') return Promise.resolve(null);
  return createImageBitmap(file).then((bitmap) => new Promise((resolve) => {
    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) { bitmap.close(); resolve(null); return; }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', 0.7);
  })).catch(() => null);
}

function acceptFiles(files, { previewId, stateId }) {
  releasePreviewUrls();
  const preview = element(previewId);
  const viewable = files.find((file) => !isHeic(file));
  if (viewable) {
    state.previewUrl = URL.createObjectURL(viewable);
    state.previewUrls.push(state.previewUrl);
    preview.src = state.previewUrl;
    preview.style.display = 'block';
  }
  if (stateId) element(stateId).textContent = `Выбрано фото: ${files.length}`;
}

/**
 * Отбор кадров на точку: берём не больше нормы вида. Пешеходному переходу нужно
 * два снимка — оба направления, — поэтому форма принимает несколько файлов.
 */
function pickFile(event, options) {
  const chosen = [...(event.target.files || [])];
  if (!chosen.length) { state.files = []; updateUploadButton(); return; }
  const limit = photoRequirementFor(state.entry?.objectType);
  const accepted = [];
  for (const file of chosen) {
    if (accepted.length >= limit) break;
    if (isHeic(file)) {
      showToast('Формат HEIC не поддерживается — сохраните фото как JPEG и выберите его снова.', 'error');
      continue;
    }
    if (!isSupportedFile(file)) {
      showToast('Поддерживаются JPEG, PNG и WEBP.', 'error');
      continue;
    }
    if (file.size > MAX_FILE_BYTES) {
      showToast('Размер файла больше 20 МБ.', 'error');
      continue;
    }
    accepted.push(file);
  }
  if (!accepted.length) { state.files = []; event.target.value = ''; updateUploadButton(); return; }
  state.files = accepted;
  state.idempotencyKey = '';
  state.idempotencySignature = '';
  acceptFiles(accepted, options);
  setSendState('idle', `Выбрано фото: ${accepted.length} из ${limit} — ещё не отправлено.`);
  updateUploadButton();
}

// A reportable object can own several registered points (a PP groups coordinate rows),
// so the distance must be measured to the nearest one exactly like the service does.
async function referencePointsFor(record) {
  if (state.referencePoints.has(record.id)) return state.referencePoints.get(record.id);
  let points = [{ latitude: Number(record.lat), longitude: Number(record.lon) }];
  try {
    const body = await apiJson(`/objects/resolve?datasetId=${encodeURIComponent(state.entry.datasetId)}&sourceId=${encodeURIComponent(record.id)}`);
    for (const object of body.objects || []) {
      const resolved = (object.reference_points || [])
        .map((point) => ({ latitude: Number(point.latitude), longitude: Number(point.longitude) }))
        .filter((point) => Number.isFinite(point.latitude) && Number.isFinite(point.longitude));
      if (resolved.length) points = resolved;
    }
  } catch {
    // Anonymous or offline: the map point of this row is still a fair estimate.
  }
  state.referencePoints.set(record.id, points);
  return points;
}

function requestGps(noteId, record) {
  const note = element(noteId);
  if (!navigator.geolocation) {
    note.textContent = 'Этот браузер не умеет определять координаты.';
    return;
  }
  note.textContent = 'Определяем координаты…';
  navigator.geolocation.getCurrentPosition(async (position) => {
    // Точка по сети вместо спутника: одна координата на город, точность в сотни
    // километров. Отправлять нельзя — такая фиксация не подтверждает место.
    if (accuracyVerdict(position.coords.accuracy) === 'unusable') {
      state.gps = null;
      note.textContent = `Координаты определены приблизительно по сети, а не по спутнику: точность около ${Math.round(position.coords.accuracy / 1000)} км. Включите геолокацию и повторите — такая фиксация место не подтверждает.`;
      updateUploadButton();
      return;
    }
    state.gps = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      accuracy: position.coords.accuracy,
      capturedAt: new Date().toISOString(),
    };
    const accuracyNote = state.gps.accuracy > 5
      ? ' · точность хуже 5 м, фиксация уйдёт на ручную проверку'
      : '';
    note.textContent = `GPS ${formatCoordinates(state.gps.lat, state.gps.lon)} · точность около ${Math.round(state.gps.accuracy)} м${accuracyNote}.`;
    const target = record || state.selected;
    if (target && state.entry) {
      const points = await referencePointsFor(target);
      const distance = gpsDistanceLabel({ latitude: state.gps.lat, longitude: state.gps.lon }, points);
      // Расстояние показываем справочно: риском оно больше не помечается, GPS
      // не обязателен, и фиксация уходит на проверку в любом случае.
      note.textContent += ` ${distance}`;
    }
    updateUploadButton();
  }, (error) => {
    state.gps = null;
    note.textContent = `GPS не получен: ${error.message || 'разрешение не выдано'}. Без координат отправка запрещена.`;
    updateUploadButton();
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
}

async function sendPhoto(record, performerNode, commentNode) {
  if (!state.files.length) { showToast('Выберите фотографию.', 'error'); return false; }
  const performer = (state.performer || performerNode?.value || '').trim();
  if (!performer) { showToast(errorText('performer_required'), 'error'); performerNode?.focus(); return false; }
  const total = state.files.length;
  setSendState('sending', total > 1 ? `Отправляется ${total} фото… не закрывайте страницу.` : 'Отправляется… не закрывайте страницу.');
  try {
    let last = null;
    let duplicate = false;
    let sent = 0;
    for (const file of [...state.files]) {
      const blob = await compressImage(file);
      const form = new FormData();
      form.append('file', blob, file.name || 'photo.jpg');
      const thumbnail = await makeThumbnail(file);
      if (thumbnail) form.append('thumbnail', thumbnail, 'preview.jpg');
      form.append('datasetId', state.entry.datasetId);
      form.append('sourceId', record.id);
      form.append('performer', performer);
      form.append('comment', commentNode.value.trim());
      // GPS не обязателен: координаты отправляем, только если их определили.
      if (state.gps) {
        form.append('gpsLat', state.gps.lat);
        form.append('gpsLon', state.gps.lon);
        form.append('gpsAccuracyM', state.gps.accuracy);
        form.append('capturedAt', state.gps.capturedAt);
      }
      if (total > 1) setSendState('sending', `Отправляется фото ${sent + 1} из ${total}… не закрывайте страницу.`);
      const response = await api('/photos', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKeyFor(record, file) }, body: form });
      let body = null;
      try { body = await response.json(); } catch { body = null; }
      if (!response.ok) throw Object.assign(new Error(errorText(body?.error, body?.message) || `Сервис ответил ${response.status}`), { code: body?.error, status: response.status });
      // Отправленный кадр убираем из формы сразу: если упадёт второй, повтор
      // дошлёт только его, а первый не создаст дубль.
      state.files = state.files.filter((item) => item !== file);
      sent += 1;
      duplicate = duplicate || Boolean(body?.duplicate);
      last = body;
    }
    const review = [last?.geoStatus, last?.reviewStatus].filter(Boolean).map((value) => geoStatusText(value)).join(' · ');
    setSendState('review', `Отправлено фото: ${sent}${duplicate ? ' (повтор не создал дубль)' : ''}. `
      + `${last?.distanceM === null || last?.distanceM === undefined ? '' : `Дистанция ${formatMeters(last.distanceM)}. `}`
      + `${review || 'Ожидает проверки.'} В подтверждённые попадёт после проверки.`);
    state.files = [];
    state.gps = null;
    state.idempotencyKey = '';
    state.idempotencySignature = '';
    releasePreviewUrls();
    for (const id of ['paFile', 'paQueueFile']) { const input = element(id); if (input) input.value = ''; }
    await refreshCoverage();
    updateUploadButton();
    return true;
  } catch (error) {
    setSendState('error', `Ошибка отправки: ${error.message}. Повторная отправка не создаст дубль — нажмите ещё раз.`);
    return false;
  }
}

/* ------------------------------------------------------------------- queue */

function readPerformer() {
  try { return sessionStorage.getItem(PERFORMER_KEY) || ''; } catch { return ''; }
}

function writePerformer(value) {
  try { sessionStorage.setItem(PERFORMER_KEY, value); } catch { /* ignore */ }
}

/**
 * Один исполнитель на страницу: значение хранится в состоянии, оба поля
 * (в карточке и в очереди) показывают его же. Без этого ввод в одном поле
 * не влиял на кнопку в другом, и отправка требовала «указать исполнителя» заново.
 */
function setPerformer(value, sourceNode) {
  const text = String(value || '').trim();
  state.performer = text;
  writePerformer(text);
  for (const id of ['paPerformer', 'paQueuePerformer']) {
    const node = element(id);
    if (node && node !== sourceNode && node.value !== text) node.value = text;
  }
  updateUploadButton();
}

// Filtering and re-sorting 10k entrance rows on every button state change is wasteful,
// so the queue is computed once per filter change.
let queueCache = null;

function invalidateQueue() {
  queueCache = null;
}

function queueList() {
  if (!state.dataset) return [];
  if (!queueCache) {
    queueCache = buildQueue(currentRecords(), { coverageIndex: state.coverage, objectType: state.entry.objectType });
  }
  return queueCache;
}

function queueRecord() {
  const queue = queueList();
  if (!queue.length) return null;
  return queue[Math.min(state.queueIndex, queue.length - 1)];
}

function renderQueue() {
  if (!state.dataset) return;
  const queue = queueList();
  const card = element('paQueueCard');
  card.replaceChildren();
  element('paQueueProgress').textContent = queue.length
    ? `Осталось ${queue.length.toLocaleString('ru-RU')} объектов · показан ${Math.min(state.queueIndex + 1, queue.length)}`
    : 'В очереди нет объектов — по всем есть кадры.';
  const record = queueRecord();
  if (!record) {
    const done = document.createElement('p');
    done.className = 'pa-queue-where';
    done.textContent = 'Для выбранных фильтров по всем объектам есть кадры.';
    card.appendChild(done);
    setSendState('idle', 'Нет объектов для съёмки.');
    return;
  }
  const coverage = coverageFor(state.coverage, record, state.entry.objectType);
  const title = document.createElement('h2');
  title.className = 'pa-queue-title';
  title.textContent = record.label;
  const where = document.createElement('p');
  where.className = 'pa-queue-where';
  where.textContent = record.group || 'Группа не указана';
  const grid = document.createElement('dl');
  grid.className = 'pa-queue-grid';
  const rows = [
    ['Статус', `${coverage.statusLabel} · ${coverageCounterText(coverage)}`],
    ['Осталось снять', String(coverage.remaining)],
    ['Координаты', formatCoordinates(record.lat, record.lon)],
  ];
  for (const [key, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = key;
    const description = document.createElement('dd');
    description.textContent = value;
    grid.append(term, description);
  }
  card.append(title, where, grid);
  if (state.previewUrl) {
    const preview = document.createElement('img');
    preview.className = 'pa-queue-preview';
    preview.src = state.previewUrl;
    preview.alt = 'Предпросмотр выбранного фото';
    card.appendChild(preview);
  }
  updateUploadButton();
}

/* ----------------------------------------------------------------- exports */

function renderExports() {
  // Exports are a prefecture tool: a district account only uploads photos.
  element('paExports').hidden = !canExport(state.user);
}

async function downloadReport(kind) {
  if (!canExport(state.user)) {
    showToast('Выгрузки доступны только префектуре.', 'error');
    return;
  }
  if (kind === 'photos') return downloadPhotoArchive();
  const district = requestedDistrict();
  const query = district ? `?district=${encodeURIComponent(district)}` : '';
  const path = kind === 'xlsx' ? `/reports/export.xlsx${query}`
    : kind === 'headquarters' ? `/reports/export-headquarters.xlsx${query}`
    : kind === 'headquarters-pdf' ? `/reports/export-headquarters.pdf${query}`
    : kind === 'districts' ? `/reports/export-districts.xlsx${query}`
    : kind === 'day' ? `/reports/daily.xlsx${query}`
    : kind === 'day-pdf' ? `/reports/daily.pdf${query}`
    : `/reports/export.pdf${query}`;
  try {
    showToast('Готовим выгрузку…');
    const response = await api(path);
    if (!response.ok) throw new Error(`Сервис ответил ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = kind === 'xlsx' ? 'sao-photo-report.xlsx'
      : kind === 'headquarters' ? 'sao-photo-headquarters.xlsx'
      : kind === 'headquarters-pdf' ? 'sao-photo-headquarters.pdf'
      : kind === 'districts' ? 'sao-photo-districts.xlsx'
      : kind === 'day' ? 'sao-photo-day.xlsx'
      : kind === 'day-pdf' ? 'sao-photo-day.pdf'
      : 'sao-photo-summary.pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('Выгрузка готова.');
  } catch (error) {
    showToast(`Не удалось выгрузить отчёт: ${error.message}`, 'error');
  }
}

/**
 * Архив фотографий собирается на сервере в файл, а не отдаётся потоком в ответ:
 * выгрузка всего округа весит гигабайты, и браузер такой ответ в память не возьмёт.
 * Поэтому сначала задача сборки, затем обычная ссылка на готовый файл — её открывает
 * браузер, показывает прогресс и умеет докачать после обрыва связи. Ссылка несёт
 * билет: cookie с чужого сайта при скачивании навигацией может не дойти.
 */
async function downloadPhotoArchive() {
  const district = requestedDistrict();
  const query = district ? `?district=${encodeURIComponent(district)}` : '';
  try {
    showToast('Собираем архив фотографий… это может занять несколько минут.');
    let job = await apiJson(`/reports/photos.zip/prepare${query}`, { method: 'POST' });
    while (job.status === 'building') {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      job = await apiJson(`/reports/photos.zip/prepare/${job.id}`);
      // Ход сборки показываем в строке состояния панели: она есть всегда.
      element('paListCount').textContent = job.total
        ? `Собираем архив: ${job.photos.toLocaleString('ru-RU')} из ${job.total.toLocaleString('ru-RU')} снимков`
          + `, ${(job.bytes / 1024 / 1024).toFixed(0)} МБ`
        : 'Собираем архив фотографий…';
    }
    if (job.status !== 'ready') throw new Error(job.error || 'архив не собрался');
    const link = document.createElement('a');
    link.href = `${apiBase()}/reports/photos.zip/file/${encodeURIComponent(job.name)}?ticket=${encodeURIComponent(job.ticket)}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast(`Архив готов: ${job.photos.toLocaleString('ru-RU')} снимков, ${(job.bytes / 1024 / 1024).toFixed(0)} МБ.`);
  } catch (error) {
    showToast(`Не удалось собрать архив: ${error.message}`, 'error');
  }
}

function downloadCsv() {
  if (!canExport(state.user)) {
    showToast('Выгрузки доступны только префектуре.', 'error');
    return;
  }
  const byId = new Map(state.dataset.records.map((record) => [record.id, record]));
  const escape = (value) => `"${String(value == null ? '' : value).replace(/\r\n|\r|\n/g, ' ').replace(/"/g, '""')}"`;
  const lines = state.dataset.exportGroups.map((ids) => {
    const group = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!group.length) return '';
    const first = group[0];
    const description = group.map((record, index) => {
      const prefix = group.length > 1 ? `Исходная запись ${index + 1} из ${group.length}: ` : '';
      return prefix + Object.entries(record.properties || {})
        .filter(([, value]) => value !== null && value !== '')
        .map(([key, value]) => `${key}: ${String(value)}`).join(' | ');
    }).join(' || ');
    const label = group.length > 1 ? `${first.label} (+${group.length - 1} записи)` : first.label;
    return [
      Number(first.lat).toFixed(6), Number(first.lon).toFixed(6),
      escape(description), escape(label), escape(first.sourceNumber),
    ].join(';');
  });
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = state.dataset.exportName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast(`CSV для Конструктора Яндекса создан: ${lines.length.toLocaleString('ru-RU')} меток.`);
}

/* ---------------------------------------------------------------- scenarios */

// On narrow screens the register is a drawer over the map, so the map stays the
// working contour and never sits below a long list.
function setPanelOpen(open) {
  element('paSide').dataset.open = open ? 'true' : 'false';
  element('paPanelBackdrop').dataset.open = open ? 'true' : 'false';
  element('paPanelToggle').setAttribute('aria-expanded', String(open));
}

function setScenario(name) {
  state.scenario = name;
  setPanelOpen(false);
  try { sessionStorage.setItem(SCENARIO_KEY, name); } catch { /* ignore */ }
  const queue = name === 'queue';
  element('paQueuePanel').hidden = !queue;
  element('paRegisterPanel').hidden = queue;
  element('paQueueTab').setAttribute('aria-selected', String(queue));
  element('paRegisterTab').setAttribute('aria-selected', String(!queue));
  if (queue) renderQueue();
  else if (state.map) state.map.container.fitToViewport();
}

/* -------------------------------------------------------------------- boot */

function shell() {
  document.body.insertAdjacentHTML('afterbegin', `
<div class="pa-app">
  <header class="pa-topbar">
    <div class="pa-brand">
      <span class="pa-brand-mark" aria-hidden="true">⌖</span>
      <span><strong id="paTitle">Фотофиксация объектов САО</strong><small id="paSubtitle">Загружаем набор данных…</small></span>
    </div>
    <a class="pa-atlas-link" href="../hub/">← Городской атлас</a>
    <nav class="pa-datasets" id="paDatasets" role="tablist" aria-label="Набор объектов"></nav>
    <div class="pa-session">
      <form class="pa-login" id="paLoginForm">
        <label class="pa-sr" for="paLoginInput">Название района</label>
        <input id="paLoginInput" type="text" placeholder="Название района" autocomplete="username">
        <label class="pa-sr" for="paPasswordInput">Пароль</label>
        <input id="paPasswordInput" type="password" placeholder="Пароль" autocomplete="current-password">
        <button type="submit" class="pa-btn pa-btn-primary" id="paLoginButton">Войти</button>
      </form>
      <button type="button" class="pa-btn" id="paLogoutButton" hidden>Выйти</button>
      <p class="pa-session-state" id="paSessionState">Проверяем сессию…</p>
    </div>
  </header>

  <div class="pa-scenarios" role="tablist" aria-label="Режим работы">
    <button type="button" role="tab" id="paRegisterTab" aria-controls="paRegisterPanel" aria-selected="true">Ведомость по району</button>
    <button type="button" role="tab" id="paQueueTab" aria-controls="paQueuePanel" aria-selected="false">Маршрутная очередь</button>
  </div>

  <main class="pa-main">
    <section class="pa-register" id="paRegisterPanel" role="tabpanel" aria-labelledby="paRegisterTab">
      <aside class="pa-side" id="paSide" aria-label="Сводка, фильтры и список объектов">
        <div class="pa-side-head">
          <strong>Список и фильтры</strong>
          <button type="button" class="pa-btn pa-panel-close" id="paPanelClose">Закрыть</button>
        </div>
        <div class="pa-summary" id="paSummary"></div>
        <section class="pa-dashboard" id="paDashboard" aria-labelledby="paDashboardTitle" hidden>
          <h2 class="pa-dashboard-title" id="paDashboardTitle">Районы округа</h2>
          <div class="pa-board-switch" id="paBoardSwitch" role="group" aria-label="Вид оцифровки"></div>
          <div class="pa-board" id="paDistrictBoard" role="list"></div>
        </section>
        <div class="pa-filters">
          <div>
            <label class="pa-label" for="paSearch">Поиск по адресу, району и атрибутам</label>
            <input class="pa-input" id="paSearch" type="search" placeholder="Начните вводить…" autocomplete="off">
          </div>
          <div>
            <label class="pa-label" for="paDistrictFilter">Район</label>
            <select class="pa-input" id="paDistrictFilter"><option value="">Весь САО</option></select>
          </div>
          <div>
            <label class="pa-label" for="paGroupFilter" id="paGroupLabel">Группа</label>
            <select class="pa-input" id="paGroupFilter"><option value="">Все</option></select>
          </div>
          <div>
            <label class="pa-label" for="paStatusFilter">Фото</label>
            <select class="pa-input" id="paStatusFilter">
              <option value="all">Все объекты</option>
              <option value="without">Без фото</option>
              <option value="incomplete">Не хватает кадра — осталось снять</option>
              <option value="with">С фото</option>
              <option value="done">Выполнено</option>
              <option value="partial">Частично</option>
              <option value="pending">На проверке</option>
            </select>
          </div>
        </div>
        <div class="pa-exports" id="paExports" hidden>
          <button type="button" class="pa-btn" id="paExportDay">Excel: отчёт за день</button>
          <button type="button" class="pa-btn" id="paExportDayPdf">PDF: отчёт за день</button>
          <button type="button" class="pa-btn" id="paExportXlsx">Excel: полный реестр</button>
          <button type="button" class="pa-btn" id="paExportDistricts">Excel: по районам</button>
          <button type="button" class="pa-btn" id="paExportHeadquarters">Excel: таблица на штаб</button>
          <button type="button" class="pa-btn" id="paExportHeadquartersPdf">PDF: таблица на штаб</button>
          <button type="button" class="pa-btn" id="paExportPdf">PDF: краткая сводка</button>
          <button type="button" class="pa-btn" id="paExportCsv">CSV для Яндекса</button>
          <button type="button" class="pa-btn" id="paExportPhotos">Архив фото (ZIP)</button>
        </div>
        <p class="pa-list-head" id="paListCount" role="status">Загружаем объекты…</p>
        <div class="pa-list" id="paList" role="list"></div>
      </aside>
      <section class="pa-map-panel" aria-label="Интерактивная карта">
        <div id="paMap" role="application" aria-label="Карта объектов"></div>
        <p class="pa-map-status" id="paMapStatus">Загрузка карты…</p>
        <p class="pa-boundary" id="paBoundaryNote">Границы районов не показаны.</p>
        <p class="pa-legend" id="paLegend"></p>
        <button type="button" class="pa-btn pa-panel-toggle" id="paPanelToggle" aria-expanded="false" aria-controls="paSide">Список и фильтры</button>
      </section>
    </section>

    <div class="pa-panel-backdrop" id="paPanelBackdrop" data-open="false"></div>

    <section class="pa-queue" id="paQueuePanel" role="tabpanel" aria-labelledby="paQueueTab" hidden>
      <div class="pa-queue-head">
        <p class="pa-queue-progress" id="paQueueProgress" role="status">—</p>
        <label class="pa-queue-performer" for="paQueuePerformer">
          <span class="pa-sr">Исполнитель</span>
          <input id="paQueuePerformer" type="text" maxlength="120" placeholder="Фамилия, инициалы" autocomplete="name">
        </label>
        <button type="button" class="pa-btn" id="paQueueSkip">Пропустить и дальше</button>
      </div>
      <article class="pa-queue-card" id="paQueueCard"></article>
      <label class="pa-queue-comment" for="paQueueComment">
        <span class="pa-label">Комментарий (необязательно)</span>
        <input id="paQueueComment" type="text" maxlength="1000" placeholder="Что зафиксировано…">
      </label>
      <div class="pa-queue-actions">
        <label class="pa-btn pa-btn-camera" for="paQueueFile" id="paQueueFileLabel">Сделать фото</label>
        <input class="pa-sr" id="paQueueFile" type="file" accept="image/jpeg,image/png,image/webp" capture="environment">
        <button type="button" class="pa-btn" id="paQueueGps">Определить GPS</button>
        <button type="button" class="pa-btn pa-btn-primary" id="paQueueSave">Отправить фото</button>
      </div>
      <p class="pa-queue-state" id="paQueueState" role="status" data-state="idle">Не отправлено.</p>
      <p class="pa-queue-gps" id="paQueueGpsNote">GPS не обязателен: без координат фото уйдёт на ручную проверку.</p>
    </section>
  </main>
</div>

<dialog class="pa-dialog" id="paDialog" aria-labelledby="paDialogTitle">
  <form method="dialog" class="pa-dialog-close-form"><button class="pa-close" aria-label="Закрыть карточку объекта">×</button></form>
  <h2 id="paDialogTitle"></h2>
  <p class="pa-dialog-subtitle" id="paDialogSubtitle"></p>
  <div class="pa-status-line" id="paDialogStatus"></div>
  <h3>Данные источника</h3>
  <div class="pa-data" id="paDialogData"></div>
  <h3>Добавить фотофиксацию</h3>
  <form class="pa-upload" id="paUploadForm">
    <label for="paFile" id="paFileLabel">Фотография (JPEG, PNG или WEBP)</label>
    <input class="pa-file" id="paFile" type="file" accept="image/jpeg,image/png,image/webp" capture="environment">
    <img class="pa-preview" id="paPreview" alt="Предпросмотр выбранной фотографии">
    <p class="pa-note" id="paLimitNote"></p>
    <label for="paPerformer">Исполнитель</label>
    <input id="paPerformer" type="text" maxlength="120" placeholder="Фамилия, инициалы">
    <label for="paComment">Комментарий</label>
    <textarea id="paComment" maxlength="1000" placeholder="Что зафиксировано…"></textarea>
    <div class="pa-upload-actions">
      <button type="button" class="pa-btn" id="paGpsButton">Определить GPS</button>
      <button type="submit" class="pa-btn pa-btn-primary" id="paSave" disabled>Отправить фото</button>
    </div>
    <p class="pa-note" id="paGpsNote">GPS не обязателен: координаты можно определить кнопкой, а можно отправить фото без них.</p>
    <p class="pa-note" id="paUploadState" role="status" data-state="idle">Не отправлено.</p>
  </form>
  <h3>Сохранённые фотографии</h3>
  <div class="pa-gallery" id="paGallery"></div>
</dialog>

<p class="pa-toast" id="paToast" role="status" aria-live="polite"></p>`);
}

function bindEvents() {
  element('paLoginForm').addEventListener('submit', submitLogin);
  element('paLogoutButton').addEventListener('click', submitLogout);
  element('paRegisterTab').addEventListener('click', () => setScenario('register'));
  element('paQueueTab').addEventListener('click', () => setScenario('queue'));
  element('paPanelToggle').addEventListener('click', () => setPanelOpen(true));
  element('paPanelClose').addEventListener('click', () => setPanelOpen(false));
  element('paPanelBackdrop').addEventListener('click', () => setPanelOpen(false));
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && element('paSide').dataset.open === 'true') setPanelOpen(false);
  });
  element('paSearch').addEventListener('input', debounce(() => { invalidateQueue(); renderList(); renderMapObjects(); renderQueue(); }, 220));
  element('paGroupFilter').addEventListener('change', () => { invalidateQueue(); renderList(); renderMapObjects(); renderQueue(); });
  element('paStatusFilter').addEventListener('change', () => { invalidateQueue(); renderList(); renderMapObjects(); renderQueue(); });
  element('paDistrictFilter').addEventListener('change', () => { invalidateQueue(); state.fitDistrict = true; refreshCoverage(); });
  element('paExportDay').addEventListener('click', () => downloadReport('day'));
  element('paExportDayPdf').addEventListener('click', () => downloadReport('day-pdf'));
  element('paExportXlsx').addEventListener('click', () => downloadReport('xlsx'));
  element('paExportDistricts').addEventListener('click', () => downloadReport('districts'));
  element('paExportHeadquarters').addEventListener('click', () => downloadReport('headquarters'));
  element('paExportHeadquartersPdf').addEventListener('click', () => downloadReport('headquarters-pdf'));
  element('paExportPdf').addEventListener('click', () => downloadReport('pdf'));
  element('paExportCsv').addEventListener('click', downloadCsv);
  element('paExportPhotos').addEventListener('click', () => downloadReport('photos'));
  element('paDialog').addEventListener('close', () => {
    releaseObjectUrls();
    state.selected = null;
    if (state.lastFocused && document.contains(state.lastFocused)) state.lastFocused.focus();
  });
  element('paDialog').addEventListener('click', (event) => {
    if (event.target === element('paDialog')) closeRecord();
  });
  element('paFile').addEventListener('change', (event) => pickFile(event, { previewId: 'paPreview', stateId: null }));
  element('paGpsButton').addEventListener('click', () => requestGps('paGpsNote', state.selected));
  element('paUploadForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!state.selected) return;
    await sendPhoto(state.selected, element('paPerformer'), element('paComment'));
    await renderGallery(state.selected);
    updateUploadButton();
  });
  element('paPerformer').addEventListener('input', (event) => setPerformer(event.target.value, event.target));
  element('paPerformer').addEventListener('change', (event) => setPerformer(event.target.value, event.target));
  element('paQueueFile').addEventListener('change', (event) => pickFile(event, { previewId: 'paPreview', stateId: 'paQueueGpsNote' }));
  element('paQueueGps').addEventListener('click', () => requestGps('paQueueGpsNote', queueRecord()));
  element('paQueuePerformer').addEventListener('input', (event) => setPerformer(event.target.value, event.target));
  element('paQueuePerformer').addEventListener('change', (event) => setPerformer(event.target.value, event.target));
  element('paQueueSkip').addEventListener('click', () => { state.queueIndex += 1; renderQueue(); });
  element('paQueueSave').addEventListener('click', async () => {
    const record = queueRecord();
    if (!record) return;
    const performer = element('paQueuePerformer');
    const ok = await sendPhoto(record, performer, element('paQueueComment'));
    if (ok) {
      element('paQueueComment').value = '';
      state.queueIndex = 0;
      invalidateQueue();
      renderQueue();
      element('paQueueGpsNote').textContent = 'Фото отправлено. Переходите к следующему объекту.';
    }
  });
}

function debounce(callback, delay) {
  let timer = null;
  return () => {
    clearTimeout(timer);
    timer = setTimeout(callback, delay);
  };
}

export async function startPhotoApp(options = {}) {
  shell();
  bindEvents();
  setPerformer(readPerformer());
  renderExports();
  try {
    await loadManifest();
  } catch (error) {
    element('paSubtitle').textContent = error.message;
    element('paListCount').textContent = 'Набор данных недоступен.';
    return;
  }
  state.districts = await loadDistrictBoundaries();
  const params = new URLSearchParams(location.search);
  let scenario = options.scenario || params.get('scenario');
  if (!scenario) { try { scenario = sessionStorage.getItem(SCENARIO_KEY); } catch { scenario = null; } }
  setScenario(scenario === 'queue' ? 'queue' : 'register');
  await selectDataset(options.dataset || params.get('dataset') || state.manifest.datasets[0].key);
  await restoreSession();
  await refreshCoverage();
  if (window.ymaps) {
    window.ymaps.ready(() => { state.mapReady = true; buildMap(); });
  } else {
    element('paMapStatus').textContent = 'Не загрузился API Яндекс Карт: проверьте интернет и ограничения ключа.';
  }
}
