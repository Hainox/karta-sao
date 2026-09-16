import {
  accuracyVerdict, assessDistanceRisk, bandNote, bandText, boundaryNote, buildCoverageIndex, buildQueue, canExport,
  completionLabel, coverageFor, districtBoundaries, filterRecords, formatCoordinates, formatMeters,
  geoStatusText, gpsDistanceLabel, groupLabel, groupValues, photoDetailRows, photoRequirement,
  reportSummaryRows, scopedDistricts, statusText,
} from './photo-model.js';

const API_FALLBACK = 'https://obhod-sao.ru/photo-api';
const TOKEN_KEY = 'sao-photo-service-token';
const SCENARIO_KEY = 'sao-photo-service-scenario';
const PERFORMER_KEY = 'sao-photo-service-performer';
const LIST_CAP = 250;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
const SUPPORTED_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];

const STATUS_COLOR = { done: '#0c7a5a', partial: '#b8791a', pending: '#2f6fb0', empty: '#b4552f' };

const state = {
  manifest: null,
  entry: null,
  dataset: null,
  coverage: new Map(),
  summary: null,
  user: null,
  token: '',
  scenario: 'register',
  queueIndex: 0,
  selected: null,
  file: null,
  previewUrl: '',
  gps: null,
  idempotencyKey: '',
  idempotencySignature: '',
  sendState: 'idle',
  objectUrls: [],
  map: null,
  pointLayer: null,
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
    const message = body?.message || body?.error || `Сервис ответил ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }
  return body;
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
    await refreshCoverage();
    showToast('Вход выполнен.');
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
function showToast(message, kind = 'info') {
  const toast = element('paToast');
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.dataset.visible = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.dataset.visible = 'false'; }, 5200);
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

async function refreshCoverage() {
  if (!state.user) {
    state.coverage = new Map();
    state.summary = null;
    invalidateQueue();
    renderAll();
    return;
  }
  const district = requestedDistrict();
  const query = district ? `?district=${encodeURIComponent(district)}` : '';
  try {
    state.summary = await apiJson(`/reports/summary${query}`);
    state.coverage = buildCoverageIndex(state.summary);
    if (!district) state.boardAll = state.summary.byDistrict || [];
    fillDistrictFilter();
  } catch (error) {
    state.coverage = new Map();
    state.summary = null;
    showToast(`Сводка недоступна: ${error.message}`, 'error');
  }
  invalidateQueue();
  renderAll();
}

function fillDistrictFilter() {
  if (state.user?.role === 'district_editor' || !state.summary) return;
  const select = element('paDistrictFilter');
  const current = select.value;
  const districts = [...new Set((state.summary.objects || []).map((object) => object.district).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, 'ru'));
  select.replaceChildren(new Option('Весь САО', ''));
  for (const district of districts) select.appendChild(new Option(district, district));
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

/* ---------------------------------------------------------------- rendering */

function renderAll() {
  renderSummary();
  renderDashboard();
  renderList();
  renderMapObjects();
  renderBoundaries();
  renderQueue();
}

/**
 * Доска округа нужна префектуре: район и так видит только себя. Когда префектура
 * проваливается в один район, показываем сохранённый срез по всему округу.
 */
function boardDistricts() {
  if (!canExport(state.user)) return [];
  if (requestedDistrict()) return state.boardAll?.length ? state.boardAll : (state.summary?.byDistrict || []);
  return state.summary?.byDistrict || [];
}

function boardRow(district) {
  const unassigned = !district.district;
  const row = document.createElement(unassigned ? 'div' : 'button');
  if (!unassigned) row.type = 'button';
  row.className = 'pa-board-row';
  row.setAttribute('role', 'listitem');
  if (unassigned) row.dataset.scope = 'unassigned';

  const caption = document.createElement('span');
  const name = document.createElement('span');
  name.className = 'pa-board-name';
  name.textContent = district.district || 'Без района';
  const note = document.createElement('span');
  note.className = 'pa-board-note';
  note.textContent = `${district.completedObjects} из ${district.totalObjects} объектов`;
  caption.append(name, note);

  const bar = document.createElement('span');
  bar.className = 'pa-board-bar';
  bar.dataset.band = district.statusBand || 'none';
  const fill = document.createElement('span');
  fill.style.width = `${Math.max(0, Math.min(100, district.completionPercent || 0))}%`;
  bar.appendChild(fill);

  const value = document.createElement('span');
  value.className = 'pa-board-value';
  value.textContent = completionLabel({ overall: district });

  row.append(caption, bar, value);
  if (!unassigned) {
    row.title = `Показать только ${district.district}`;
    row.addEventListener('click', () => {
      element('paDistrictFilter').value = district.district;
      invalidateQueue();
      refreshCoverage();
    });
  }
  return row;
}

function renderDashboard() {
  const board = element('paDashboard');
  const list = element('paDistrictBoard');
  const districts = boardDistricts();
  if (districts.length <= 1) {
    board.hidden = true;
    list.replaceChildren();
    return;
  }
  board.hidden = false;
  list.replaceChildren();
  for (const district of districts) list.appendChild(boardRow(district));
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
  value.textContent = completionLabel(state.summary);
  const band = document.createElement('span');
  band.className = 'pa-summary-band';
  band.dataset.band = state.summary.overall?.statusBand || 'none';
  band.textContent = `${bandText(state.summary.overall?.statusBand)} — ${bandNote(state.summary.overall?.statusBand)}`;
  head.append(value, band);
  box.appendChild(head);

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

  if (state.summary.unassigned && state.summary.unassigned.totalObjects > 0 && !element('paDistrictFilter').value) {
    const note = document.createElement('p');
    note.className = 'pa-unassigned';
    note.textContent = `Без района: ${state.summary.unassigned.totalObjects} объектов `
      + `(${String(state.summary.unassigned.objectsWithoutPhoto)} без фото, `
      + `${String(state.summary.unassigned.completedObjects)} выполнено). `
      + 'Эти объекты входят в сводку САО отдельной строкой и не приписаны ни одному району.';
    box.appendChild(note);
  }
}

function currentRecords() {
  return filterRecords(state.dataset?.records || [], {
    query: element('paSearch').value,
    group: element('paGroupFilter').value,
    district: scopeDistrict(),
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
    counter.textContent = `подтверждено ${coverage.confirmed} из ${coverage.required}`;
    meta.append(where, counter, rowChip(coverage.statusKey, coverage.statusLabel, coverage.pending));
    if (coverage.geoRisk) {
      const risk = document.createElement('span');
      risk.className = 'pa-chip pa-chip-risk';
      risk.textContent = 'Риск GPS';
      meta.appendChild(risk);
    }
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

// The district the register and the map are scoped to: a district account is always
// pinned to its own district, the prefecture follows its filter.
function scopeDistrict() {
  if (state.user?.role === 'district_editor') return state.user.district || '';
  return element('paDistrictFilter').value;
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
    state.pointLayer = new ymaps.ObjectManager({ clusterize: true, gridSize: 64 });
    state.pointLayer.objects.events.add('click', (event) => {
      const record = state.dataset.records[Number(event.get('objectId'))];
      if (record) openRecord(record, null);
    });
    state.map.geoObjects.add(state.pointLayer);
  }
  const features = state.dataset.records.map((record, index) => ({
    type: 'Feature',
    id: index,
    geometry: { type: 'Point', coordinates: [record.lat, record.lon] },
    properties: { recordId: record.id },
    options: { preset: 'islands#circleIcon', iconColor: STATUS_COLOR.empty },
  }));
  state.pointLayer.removeAll();
  state.pointLayer.add({ type: 'FeatureCollection', features });
  renderMapObjects();
  renderBoundaries({ fit: true });
}

function renderMapObjects() {
  if (!state.pointLayer || !state.dataset) return;
  const filtered = currentRecords();
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

function resetPhotoForm() {
  state.file = null;
  state.gps = null;
  state.idempotencyKey = '';
  state.idempotencySignature = '';
  element('paFile').value = '';
  element('paComment').value = '';
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = '';
  const preview = element('paPreview');
  preview.removeAttribute('src');
  preview.style.display = 'none';
  element('paGpsNote').textContent = 'GPS обязателен для отправки: нажмите «Определить GPS» и разрешите доступ.';
  setSendState('idle', 'Не отправлено.');
  updateUploadButton();
}

function updateUploadButton() {
  const sendable = state.sendState !== 'sending';
  const hasFile = Boolean(state.file);
  const hasGps = Boolean(state.gps);
  const dialogPerformer = Boolean((element('paPerformer').value || '').trim());
  const queuePerformer = Boolean((element('paQueuePerformer').value || '').trim());

  const saveButton = element('paSave');
  if (saveButton) {
    saveButton.disabled = !(Boolean(state.user) && hasFile && hasGps && sendable && dialogPerformer && Boolean(state.selected));
  }
  const queueButton = element('paQueueSave');
  if (queueButton) {
    queueButton.disabled = !(Boolean(state.user) && hasFile && hasGps && sendable && queuePerformer && Boolean(queueRecord()));
  }

  const note = element('paLimitNote');
  const coverage = state.selected ? coverageFor(state.coverage, state.selected, state.entry.objectType) : null;
  if (!coverage) {
    note.textContent = 'Выберите объект, чтобы добавить фото.';
    return;
  }
  const remaining = Math.max(0, coverage.required - coverage.confirmed - coverage.pending);
  const missing = [];
  if (!state.user) missing.push('войдите в фотослужбу');
  if (!hasFile) missing.push('выберите фотографию');
  if (!hasGps) missing.push('получите GPS');
  if (!dialogPerformer) missing.push('укажите исполнителя');
  note.textContent = `Подтверждено ${coverage.confirmed} из ${coverage.required}. `
    + (remaining > 0 ? `Можно добавить ещё ${remaining}. ` : 'Норма по фото уже набрана — лишнее уйдёт на проверку. ')
    + (missing.length ? `Для отправки: ${missing.join(', ')}.` : 'Всё готово к отправке.');
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
  counter.textContent = `подтверждено ${coverage.confirmed} из ${coverage.required}`;
  statusLine.appendChild(counter);
  if (coverage.geoRisk) {
    const risk = document.createElement('span');
    risk.className = 'pa-chip pa-chip-risk';
    risk.textContent = 'Есть фиксация с риском GPS';
    statusLine.appendChild(risk);
  }
  const rows = [{ key: 'Координаты на карте', value: formatCoordinates(record.lat, record.lon) }];
  for (const [key, value] of Object.entries(record.properties || {})) {
    if (value !== null && value !== undefined && value !== '') rows.push({ key, value });
  }
  addDataRows(element('paDialogData'), rows);
  resetPhotoForm();
  element('paPerformer').value = element('paPerformer').value || readPerformer();
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
    await apiJson(`/photos/${encodeURIComponent(photoId)}/review`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, isReference }),
    });
    showToast(status === 'confirmed' ? 'Фиксация подтверждена.' : 'Фиксация отклонена.');
    await refreshCoverage();
    if (record) await renderGallery(record);
  } catch (error) {
    showToast(`Не удалось изменить фиксацию: ${error.message}`, 'error');
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

function acceptFile(file, { previewId, stateId }) {
  const preview = element(previewId);
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = '';
  if (isHeic(file)) {
    preview.removeAttribute('src');
    preview.style.display = 'none';
  } else {
    state.previewUrl = URL.createObjectURL(file);
    preview.src = state.previewUrl;
    preview.style.display = 'block';
  }
  if (stateId) element(stateId).textContent = `Выбрано фото: ${file.name}`;
}

function pickFile(event, options) {
  const file = event.target.files?.[0];
  if (!file) { state.file = null; updateUploadButton(); return; }
  if (!isSupportedFile(file)) {
    state.file = null;
    showToast('Поддерживаются JPEG, PNG, WEBP, HEIC и HEIF.', 'error');
    event.target.value = '';
    updateUploadButton();
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    state.file = null;
    showToast('Размер файла больше 20 МБ.', 'error');
    event.target.value = '';
    updateUploadButton();
    return;
  }
  state.file = file;
  state.idempotencyKey = '';
  state.idempotencySignature = '';
  acceptFile(file, options);
  setSendState('idle', 'Фото выбрано, но ещё не отправлено.');
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
      note.textContent += ` ${distance}`;
      if (assessDistanceRisk({ latitude: state.gps.lat, longitude: state.gps.lon }, points).risk) {
        note.textContent += ' Фиксация всё равно отправится, но будет помечена как риск.';
      }
    }
    updateUploadButton();
  }, (error) => {
    state.gps = null;
    note.textContent = `GPS не получен: ${error.message || 'разрешение не выдано'}. Без координат отправка запрещена.`;
    updateUploadButton();
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
}

async function sendPhoto(record, performerNode, commentNode) {
  if (!state.file || !state.gps) { showToast('Нужны фотография и координаты GPS.', 'error'); return false; }
  if (accuracyVerdict(state.gps.accuracy) === 'unusable') { showToast('Координаты слишком неточные: включите геолокацию и определите их заново.', 'error'); return false; }
  const performer = performerNode.value.trim();
  if (!performer) { showToast('Укажите исполнителя.', 'error'); performerNode.focus(); return false; }
  setSendState('sending', 'Отправляется… не закрывайте страницу.');
  try {
    const blob = await compressImage(state.file);
    const form = new FormData();
    form.append('file', blob, state.file.name || 'photo.jpg');
    const thumbnail = await makeThumbnail(state.file);
    if (thumbnail) form.append('thumbnail', thumbnail, 'preview.jpg');
    form.append('datasetId', state.entry.datasetId);
    form.append('sourceId', record.id);
    form.append('performer', performer);
    form.append('comment', commentNode.value.trim());
    form.append('gpsLat', state.gps.lat);
    form.append('gpsLon', state.gps.lon);
    form.append('gpsAccuracyM', state.gps.accuracy);
    form.append('capturedAt', state.gps.capturedAt);
    const response = await api('/photos', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKeyFor(record, state.file) }, body: form });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) throw new Error(body?.message || body?.error || `Сервис ответил ${response.status}`);
    const review = [body?.geoStatus, body?.reviewStatus].filter(Boolean).map((value) => geoStatusText(value)).join(' · ');
    setSendState('review', `Отправлено${body?.duplicate ? ' (повтор не создал дубль)' : ''}. `
      + `${body?.distanceM === null || body?.distanceM === undefined ? '' : `Дистанция ${formatMeters(body.distanceM)}. `}`
      + `${review || 'Ожидает проверки.'} В подтверждённые попадёт после проверки.`);
    state.file = null;
    state.gps = null;
    state.idempotencyKey = '';
    state.idempotencySignature = '';
    if (state.previewUrl) { URL.revokeObjectURL(state.previewUrl); state.previewUrl = ''; }
    for (const id of ['paFile', 'paQueueFile']) { const input = element(id); if (input) input.value = ''; }
    const preview = element('paPreview');
    preview.removeAttribute('src');
    preview.style.display = 'none';
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
    : 'В очереди нет объектов — все подтверждены.';
  const record = queueRecord();
  if (!record) {
    const done = document.createElement('p');
    done.className = 'pa-queue-where';
    done.textContent = 'Для выбранных фильтров все объекты имеют подтверждённое фото.';
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
    ['Статус', `${coverage.statusLabel} · подтверждено ${coverage.confirmed} из ${coverage.required}`],
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
  const district = requestedDistrict();
  const query = district ? `?district=${encodeURIComponent(district)}` : '';
  const path = kind === 'xlsx' ? `/reports/export.xlsx${query}` : `/reports/export.pdf${query}`;
  try {
    showToast('Готовим выгрузку…');
    const response = await api(path);
    if (!response.ok) throw new Error(`Сервис ответил ${response.status}`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = kind === 'xlsx' ? 'sao-photo-report.xlsx' : 'sao-photo-summary.pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('Выгрузка готова.');
  } catch (error) {
    showToast(`Не удалось выгрузить отчёт: ${error.message}`, 'error');
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
              <option value="with">С фото</option>
              <option value="done">Выполнено</option>
              <option value="partial">Частично</option>
              <option value="pending">На проверке</option>
              <option value="risk">Риск GPS</option>
            </select>
          </div>
        </div>
        <div class="pa-exports" id="paExports" hidden>
          <button type="button" class="pa-btn" id="paExportXlsx">Excel: полный реестр</button>
          <button type="button" class="pa-btn" id="paExportPdf">PDF: краткая сводка</button>
          <button type="button" class="pa-btn" id="paExportCsv">CSV для Яндекса</button>
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
        <label class="pa-btn pa-btn-camera" for="paQueueFile">Сделать фото</label>
        <input class="pa-sr" id="paQueueFile" type="file" accept="image/jpeg,image/png,image/webp" capture="environment">
        <button type="button" class="pa-btn" id="paQueueGps">Определить GPS</button>
        <button type="button" class="pa-btn pa-btn-primary" id="paQueueSave">Отправить фото</button>
      </div>
      <p class="pa-queue-state" id="paQueueState" role="status" data-state="idle">Не отправлено.</p>
      <p class="pa-queue-gps" id="paQueueGpsNote">GPS обязателен: без координат сервер отклонит загрузку.</p>
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
    <p class="pa-note" id="paGpsNote">GPS обязателен для отправки.</p>
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
  element('paDistrictFilter').addEventListener('change', () => { invalidateQueue(); refreshCoverage(); });
  element('paExportXlsx').addEventListener('click', () => downloadReport('xlsx'));
  element('paExportPdf').addEventListener('click', () => downloadReport('pdf'));
  element('paExportCsv').addEventListener('click', downloadCsv);
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
  element('paPerformer').addEventListener('change', (event) => writePerformer(event.target.value.trim()));
  element('paQueueFile').addEventListener('change', (event) => pickFile(event, { previewId: 'paPreview', stateId: 'paQueueGpsNote' }));
  element('paQueueGps').addEventListener('click', () => requestGps('paQueueGpsNote', queueRecord()));
  element('paPerformer').addEventListener('input', updateUploadButton);
  element('paQueuePerformer').addEventListener('input', updateUploadButton);
  element('paQueuePerformer').addEventListener('change', (event) => writePerformer(event.target.value.trim()));
  element('paQueueSkip').addEventListener('click', () => { state.queueIndex += 1; renderQueue(); });
  element('paQueueSave').addEventListener('click', async () => {
    const record = queueRecord();
    if (!record) return;
    const performer = element('paQueuePerformer');
    const ok = await sendPhoto(record, performer, element('paQueueComment'));
    if (ok) {
      writePerformer(performer.value.trim());
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
  element('paPerformer').value = readPerformer();
  element('paQueuePerformer').value = readPerformer();
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
