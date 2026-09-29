// Страница отдела МКД: фото первых этажей подъездов.
//
// Отдельная работа со своей учёткой: здесь только подъезды, у каждого — меню
// «Первый этаж», куда отдел прикрепляет до 10 фото. Фото уходят в раздел
// `/mkd/…` фотослужбы и не попадают ни в фотофиксацию, ни в её статистику.
// Префектура открывает страницу только для просмотра и выгрузок.

import {
  districtBoundaries, formatCoordinates, formatDateTime, isDrawablePoint, mapViewportForRecords,
} from './photo-model.js';
import { errorText } from './photo-messages.js';
import {
  filterMkdRecords, MKD_CATEGORY, MKD_PHOTO_LIMIT, MKD_STATUS_COLOR, mkdCanView, mkdCanWrite, mkdCounterText,
  mkdCounters, mkdFilesToSend, mkdLimitText, mkdPhotoCount, mkdStatusKey,
} from './mkd-model.js';

const API_FALLBACK = 'https://obhod-sao.ru/photo-api';
// Сессия общая с фотофиксацией: если отдел МКД вошёл там, страница его узнает.
const TOKEN_KEY = 'sao-photo-service-token';
const PERFORMER_KEY = 'sao-mkd-performer';
const DATASET_KEY = 'entrances';
const LIST_CAP = 250;
const CLUSTER_FROM_MARKERS = 1000;
const SUPPORTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const THUMBNAIL_MAX_EDGE = 320;

const state = {
  manifest: null,
  entry: null,
  dataset: null,
  districts: null,
  summary: null,
  user: null,
  token: '',
  selected: null,
  photos: [],
  files: [],
  gps: null,
  sending: false,
  objectUrls: [],
  previewUrls: [],
  map: null,
  mapReady: false,
  pointLayer: null,
  clusterizeMode: null,
  boundaryLayer: null,
  boundarySignature: '',
  indexById: new Map(),
  lastFocused: null,
};

const element = (id) => document.getElementById(id);
const apiBase = () => window.SAO_PHOTO_API_BASE || API_FALLBACK;
const number = (value) => Number(value || 0).toLocaleString('ru-RU');

/* ------------------------------------------------------------------ сеть */

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
    const error = new Error(errorText(code, body?.message) || `Сервис ответил ${response.status}`);
    error.status = response.status;
    error.code = code;
    if (response.status === 401 && path !== '/auth/login' && state.user) {
      rememberToken('');
      setSession(null);
      showToast('Сеанс истёк — войдите заново.', 'error');
    }
    throw error;
  }
  return body;
}

function rememberToken(token) {
  state.token = token || '';
  try {
    if (state.token) sessionStorage.setItem(TOKEN_KEY, state.token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch { /* без хранилища работает cookie */ }
}

/* ---------------------------------------------------------------- сессия */

function setSession(user) {
  state.user = user || null;
  element('paLoginForm').hidden = Boolean(user);
  element('paLogoutButton').hidden = !user;
  const label = element('paSessionState');
  if (!user) label.textContent = 'Вход не выполнен — войдите учёткой отдела МКД';
  else if (mkdCanWrite(user)) label.textContent = `${user.displayName || user.email} · отдел МКД (весь САО)`;
  else if (mkdCanView(user)) label.textContent = `${user.displayName || user.email} · префектура — только просмотр`;
  else label.textContent = `${user.displayName || user.email} · раздел доступен только отделу МКД`;
  element('paExports').hidden = !mkdCanView(user);
  element('paBackLink').hidden = user?.role !== 'prefecture_admin';
}

async function restoreSession() {
  try { rememberToken(sessionStorage.getItem(TOKEN_KEY) || ''); } catch { /* ignore */ }
  try {
    setSession((await apiJson('/auth/me')).user);
  } catch {
    if (state.token) {
      rememberToken('');
      try { setSession((await apiJson('/auth/me')).user); return; } catch { /* остаёмся без входа */ }
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
    if (!mkdCanView(body.user)) {
      showToast('Эта учётка не относится к отделу МКД — фото первых этажей ей недоступны.', 'error');
    } else {
      showToast('Вход выполнен.');
    }
    await refreshSummary();
  } catch (error) {
    showToast(`Вход не выполнен: ${error.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'Войти';
  }
}

async function submitLogout() {
  try { await apiJson('/auth/logout', { method: 'POST' }); } catch { /* локально всё равно выходим */ }
  rememberToken('');
  setSession(null);
  state.summary = null;
  renderAll();
  showToast('Вы вышли.');
}

/* ----------------------------------------------------------------- тосты */

let toastTimer = null;
function showToast(message, kind = 'info') {
  const toast = element('paToast');
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.dataset.visible = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.dataset.visible = 'false'; }, kind === 'error' ? 9000 : 5200);
}

/* ---------------------------------------------------------------- данные */

async function loadData() {
  const manifestResponse = await fetch('data/manifest.json', { cache: 'no-cache' });
  if (!manifestResponse.ok) throw new Error('Не удалось прочитать описание наборов данных.');
  state.manifest = await manifestResponse.json();
  state.entry = state.manifest.datasets.find((dataset) => dataset.key === DATASET_KEY);
  if (!state.entry) throw new Error('В наборах нет подъездов.');
  const response = await fetch(`data/${state.entry.file}`, { cache: 'force-cache' });
  if (!response.ok) throw new Error('Не удалось загрузить подъезды.');
  state.dataset = await response.json();
  state.indexById = new Map(state.dataset.records.map((record, index) => [record.id, index]));
  try {
    const boundaries = await fetch('../districts.geojson', { cache: 'force-cache' });
    state.districts = boundaries.ok ? await boundaries.json() : null;
  } catch { state.districts = null; }
}

async function refreshSummary({ announce = true } = {}) {
  if (!mkdCanView(state.user)) {
    state.summary = null;
    renderAll();
    return;
  }
  try {
    state.summary = await apiJson('/mkd/summary');
  } catch (error) {
    state.summary = null;
    if (announce && error.status !== 401) showToast(`Сводка недоступна: ${error.message}`, 'error');
  }
  renderAll();
}

function currentRecords() {
  return filterMkdRecords(state.dataset?.records || [], {
    query: element('paSearch').value,
    district: element('paDistrictFilter').value,
    status: element('paStatusFilter').value,
    summary: state.summary,
  }).filter(isDrawablePoint);
}

/* ------------------------------------------------------------- отрисовка */

function renderAll() {
  renderHeader();
  renderSummary();
  renderBoard();
  renderList();
  renderMapObjects();
  renderBoundaries();
}

function renderHeader() {
  element('paSubtitle').textContent = `Фото первых этажей подъездов · отдельный учёт отдела МКД · набор ${state.manifest?.sourceDate || '—'}`;
  const tabs = element('paDatasets');
  tabs.replaceChildren();
  const parent = document.createElement('span');
  parent.className = 'pa-dataset';
  parent.textContent = `${state.entry?.title || 'Подъезды'} · ${number(state.dataset?.records.length)}`;
  const child = document.createElement('button');
  child.type = 'button';
  child.className = 'pa-dataset';
  child.setAttribute('role', 'tab');
  child.setAttribute('aria-selected', 'true');
  child.textContent = `› ${MKD_CATEGORY}`;
  tabs.append(parent, child);
}

function renderSummary() {
  const box = element('paSummary');
  box.replaceChildren();
  const note = document.createElement('p');
  note.className = 'pa-note';
  if (!state.user) {
    note.textContent = 'Войдите учёткой отдела МКД, чтобы видеть и прикреплять фото первых этажей.';
    box.appendChild(note);
    return;
  }
  if (!mkdCanView(state.user)) {
    note.textContent = 'Раздел «Первый этаж» доступен только отделу МКД и префектуре.';
    box.appendChild(note);
    return;
  }
  if (!state.summary) {
    note.textContent = 'Сводка загружается…';
    box.appendChild(note);
    return;
  }
  const head = document.createElement('div');
  head.className = 'pa-summary-head';
  const value = document.createElement('span');
  value.className = 'pa-summary-value';
  const overall = state.summary.overall;
  value.textContent = `${overall.percent} % подъездов с фото первого этажа`;
  const band = document.createElement('span');
  band.className = 'pa-summary-band';
  band.textContent = `${number(overall.withPhoto)} из ${number(overall.total)} · осталось ${number(overall.without)} · фото ${number(overall.photos)}`;
  head.append(value, band);
  const separate = document.createElement('p');
  separate.className = 'pa-note';
  separate.textContent = `Отдельный учёт отдела МКД: до ${MKD_PHOTO_LIMIT} фото на подъезд, без проверки. В фотофиксацию и её статистику не входит.`;
  box.append(head, separate);
}

function renderBoard() {
  const section = element('paDashboard');
  const board = element('paDistrictBoard');
  board.replaceChildren();
  const rows = state.summary?.byDistrict || [];
  section.hidden = !rows.length;
  fillDistrictFilter(rows.map((row) => row.district));
  for (const district of rows) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'pa-board-row';
    row.setAttribute('role', 'listitem');
    const caption = document.createElement('span');
    const name = document.createElement('span');
    name.className = 'pa-board-name';
    name.textContent = district.district;
    const noteText = document.createElement('span');
    noteText.className = 'pa-board-note';
    noteText.textContent = `с фото ${number(district.withPhoto)} из ${number(district.total)} подъездов`;
    caption.append(name, noteText);
    const bar = document.createElement('span');
    bar.className = 'pa-board-bar';
    bar.dataset.band = district.percent >= 66 ? 'green' : district.percent >= 33 ? 'yellow' : 'red';
    const fill = document.createElement('span');
    fill.style.width = `${Math.max(0, Math.min(100, district.percent))}%`;
    bar.appendChild(fill);
    const value = document.createElement('span');
    value.className = 'pa-board-value';
    value.textContent = `${district.percent} %`;
    row.append(caption, bar, value);
    row.title = `Показать только ${district.district}`;
    row.addEventListener('click', () => {
      element('paDistrictFilter').value = district.district;
      onFilterChange({ fit: true });
    });
    board.appendChild(row);
  }
}

function fillDistrictFilter(fromSummary) {
  const select = element('paDistrictFilter');
  const current = select.value;
  const names = new Set(fromSummary.filter((name) => name && name !== 'Без района'));
  for (const record of state.dataset?.records || []) if (record.group) names.add(record.group);
  select.replaceChildren(new Option('Весь САО', ''));
  for (const name of [...names].sort((left, right) => left.localeCompare(right, 'ru'))) select.appendChild(new Option(name, name));
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderList() {
  const list = element('paList');
  list.replaceChildren();
  if (!state.dataset) return;
  const filtered = currentRecords();
  const shown = filtered.slice(0, LIST_CAP);
  const counters = mkdCounters(filtered, state.summary);
  element('paListCount').textContent = `Показано ${number(shown.length)} из ${number(filtered.length)} подъездов`
    + (filtered.length > LIST_CAP ? ` · первые ${LIST_CAP}` : '')
    + (state.summary ? ` · ${mkdCounterText(counters)}` : '');
  if (!shown.length) {
    const empty = document.createElement('p');
    empty.className = 'pa-note';
    empty.textContent = 'Ничего не найдено.';
    list.appendChild(empty);
    return;
  }
  for (const record of shown) {
    const count = mkdPhotoCount(state.summary, record.id);
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
    const chip = document.createElement('span');
    chip.className = 'pa-chip';
    chip.dataset.status = count > 0 ? 'done' : 'empty';
    chip.textContent = count > 0 ? `${MKD_CATEGORY}: ${count} фото` : `${MKD_CATEGORY}: нет фото`;
    meta.append(where, chip);
    row.append(title, meta);
    row.addEventListener('click', () => openRecord(record, row));
    list.appendChild(row);
  }
}

function renderLegend() {
  const legend = element('paLegend');
  legend.replaceChildren();
  for (const [key, text] of [['with', 'Есть фото первого этажа'], ['without', 'Нет фото первого этажа']]) {
    const item = document.createElement('span');
    item.className = 'pa-legend-item';
    const dot = document.createElement('span');
    dot.className = 'pa-key';
    dot.style.background = MKD_STATUS_COLOR[key];
    item.append(dot, document.createTextNode(text));
    legend.appendChild(item);
  }
}

/* ----------------------------------------------------------------- карта */

function buildMap() {
  renderLegend();
  if (!window.ymaps) {
    element('paMapStatus').textContent = 'Не загрузился API Яндекс Карт: проверьте интернет и ограничения ключа.';
    return;
  }
  if (!state.mapReady || !state.dataset) return;
  if (!state.map) {
    state.map = new ymaps.Map('paMap', { center: [55.84, 37.52], zoom: 11, controls: ['zoomControl'] }, { suppressMapOpenBlock: true });
  }
  renderMapObjects();
  renderBoundaries({ fit: true });
}

function ensurePointLayer(clusterize) {
  if (state.pointLayer && state.clusterizeMode === clusterize) return;
  if (state.pointLayer) state.map.geoObjects.remove(state.pointLayer);
  state.pointLayer = new ymaps.ObjectManager({ clusterize, gridSize: 64 });
  state.clusterizeMode = clusterize;
  state.pointLayer.objects.events.add('click', (event) => {
    const record = state.dataset.records[Number(event.get('objectId'))];
    if (record) openRecord(record, null);
  });
  const features = state.dataset.records.flatMap((record, index) => (isDrawablePoint(record) ? [{
    type: 'Feature',
    id: index,
    geometry: { type: 'Point', coordinates: [record.lat, record.lon] },
    properties: { hintContent: record.label },
    options: { preset: 'islands#circleIcon', iconColor: MKD_STATUS_COLOR[mkdStatusKey(state.summary, record.id)] },
  }] : []));
  state.pointLayer.add({ type: 'FeatureCollection', features });
  state.map.geoObjects.add(state.pointLayer);
}

function renderMapObjects() {
  if (!state.dataset || !state.map) return;
  const filtered = currentRecords();
  ensurePointLayer(filtered.length > CLUSTER_FROM_MARKERS);
  const visible = new Set(filtered.map((record) => state.indexById.get(record.id)));
  state.pointLayer.setFilter((object) => visible.has(Number(object.id)));
  for (const record of state.dataset.records) {
    const index = state.indexById.get(record.id);
    if (index === undefined) continue;
    state.pointLayer.objects.setObjectOptions(index, { iconColor: MKD_STATUS_COLOR[mkdStatusKey(state.summary, record.id)] });
  }
  element('paMapStatus').textContent = `Показано ${number(filtered.length)} из ${number(state.dataset.records.length)} подъездов`;
}

function renderBoundaries({ fit = false } = {}) {
  if (!state.map || !state.districts) return;
  const selected = element('paDistrictFilter').value;
  const wanted = selected ? [selected] : state.districts.features.map((feature) => feature.properties.district).filter(Boolean);
  const signature = wanted.join('|');
  if (signature !== state.boundarySignature) {
    state.boundarySignature = signature;
    if (state.boundaryLayer) { state.map.geoObjects.remove(state.boundaryLayer); state.boundaryLayer = null; }
    const collection = new ymaps.GeoObjectCollection();
    for (const boundary of districtBoundaries(state.districts, wanted)) {
      collection.add(new ymaps.GeoObject({
        geometry: { type: 'Polygon', coordinates: boundary.rings },
        properties: { hintContent: boundary.district },
      }, { fillColor: 'rgba(12, 107, 83, 0.04)', strokeColor: '#0c6b53', strokeWidth: 2, interactivityModel: 'default#silent' }));
    }
    state.boundaryLayer = collection;
    state.map.geoObjects.add(collection);
    fit = true;
  }
  if (fit && state.boundaryLayer) {
    const bounds = state.boundaryLayer.getBounds();
    if (bounds) state.map.setBounds(bounds, { checkZoomRange: true, zoomMargin: 24 });
  }
}

function fitMapToRecords(records) {
  if (!state.map) return;
  const viewport = mapViewportForRecords(records);
  if (!viewport) return;
  if (viewport.pointCount === 1) state.map.setCenter(viewport.bounds[0], 17);
  else state.map.setBounds(viewport.bounds, { checkZoomRange: true, zoomMargin: 48 });
}

function onFilterChange({ fit = false } = {}) {
  renderList();
  renderMapObjects();
  renderBoundaries({ fit });
}

/* ------------------------------------------------------ карточка подъезда */

function releaseUrls(list) {
  for (const url of list.splice(0)) URL.revokeObjectURL(url);
}

async function openRecord(record, trigger) {
  state.selected = record;
  state.lastFocused = trigger || document.activeElement;
  setPanelOpen(false);
  element('paDialogTitle').textContent = record.label;
  element('paDialogSubtitle').textContent = `${record.group || '—'} · ${record.id} · ${formatCoordinates(record.lat, record.lon)}`;
  const data = element('paDialogData');
  data.replaceChildren();
  for (const [key, value] of Object.entries(record.properties || {})) {
    if (value === null || value === undefined || value === '') continue;
    const wrapper = document.createElement('div');
    wrapper.className = 'pa-data-row';
    const keyNode = document.createElement('div');
    keyNode.className = 'pa-data-key';
    keyNode.textContent = key;
    const valueNode = document.createElement('div');
    valueNode.className = 'pa-data-value';
    valueNode.textContent = String(value);
    wrapper.append(keyNode, valueNode);
    data.appendChild(wrapper);
  }
  resetForm();
  element('paUploadForm').hidden = !mkdCanWrite(state.user);
  element('paReadOnlyNote').hidden = mkdCanWrite(state.user);
  const dialog = element('paDialog');
  if (!dialog.open) dialog.showModal();
  await renderGallery(record);
}

function resetForm() {
  state.files = [];
  state.gps = null;
  element('paFile').value = '';
  element('paComment').value = '';
  element('paPerformer').value = readPerformer();
  element('paPreviews').replaceChildren();
  releaseUrls(state.previewUrls);
  element('paGpsNote').textContent = 'GPS не обязателен.';
  element('paUploadState').textContent = 'Не отправлено.';
  element('paUploadState').dataset.state = 'idle';
  updateUploadButton();
}

function updateUploadButton() {
  const room = MKD_PHOTO_LIMIT - state.photos.length;
  const ready = mkdCanWrite(state.user) && state.files.length > 0 && Boolean(element('paPerformer').value.trim()) && !state.sending && room > 0;
  element('paSave').disabled = !ready;
  element('paFile').disabled = room <= 0 || state.sending;
  element('paLimitNote').textContent = mkdLimitText(state.photos.length)
    + (state.files.length ? ` Выбрано к отправке: ${state.files.length}.` : '')
    + (element('paPerformer').value.trim() ? '' : ' Укажите исполнителя.');
}

async function loadPhotoUrl(photoId) {
  const response = await api(`/mkd/photos/${encodeURIComponent(photoId)}/content`);
  if (!response.ok) throw new Error('Файл недоступен');
  const url = URL.createObjectURL(await response.blob());
  state.objectUrls.push(url);
  return url;
}

async function renderGallery(record) {
  const gallery = element('paGallery');
  gallery.replaceChildren();
  releaseUrls(state.objectUrls);
  state.photos = [];
  if (!mkdCanView(state.user)) {
    gallery.textContent = 'Войдите учёткой отдела МКД, чтобы видеть фото первого этажа.';
    updateUploadButton();
    return;
  }
  try {
    state.photos = (await apiJson(`/mkd/photos?sourceId=${encodeURIComponent(record.id)}`)).photos || [];
  } catch (error) {
    gallery.textContent = `Не удалось прочитать фото: ${error.message}`;
    updateUploadButton();
    return;
  }
  updateUploadButton();
  if (!state.photos.length) {
    gallery.textContent = 'Фото первого этажа ещё нет.';
    return;
  }
  for (const photo of state.photos) {
    const card = document.createElement('article');
    card.className = 'pa-photo';
    const image = document.createElement('img');
    image.alt = `Первый этаж: ${record.label}`;
    const body = document.createElement('div');
    body.className = 'pa-photo-body';
    const details = document.createElement('dl');
    for (const [key, value] of [
      ['Исполнитель', photo.performer],
      ['Загружено', formatDateTime(photo.uploadedAt)],
      ['Комментарий', photo.comment || '—'],
      ['GPS', photo.gpsLatitude == null ? 'не указан' : formatCoordinates(photo.gpsLatitude, photo.gpsLongitude)],
    ]) {
      const term = document.createElement('dt');
      term.textContent = key;
      const description = document.createElement('dd');
      description.textContent = value;
      details.append(term, description);
    }
    body.appendChild(details);
    const actions = document.createElement('div');
    actions.className = 'pa-photo-actions';
    const download = document.createElement('a');
    download.className = 'pa-btn';
    download.textContent = 'Скачать фото';
    download.download = `первый-этаж-${record.id.replace(/[^0-9a-z]+/gi, '-')}.jpg`;
    actions.appendChild(download);
    if (mkdCanWrite(state.user)) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pa-btn';
      remove.textContent = 'Удалить';
      remove.addEventListener('click', () => deletePhoto(photo.id, record, remove));
      actions.appendChild(remove);
    }
    body.appendChild(actions);
    card.append(image, body);
    gallery.appendChild(card);
    loadPhotoUrl(photo.id)
      .then((url) => { image.src = url; download.href = url; })
      .catch(() => { image.alt = 'Файл недоступен'; download.remove(); });
  }
}

async function deletePhoto(photoId, record, button) {
  if (!window.confirm('Удалить это фото первого этажа? Действие нельзя отменить.')) return;
  button.disabled = true;
  try {
    await apiJson(`/mkd/photos/${encodeURIComponent(photoId)}`, { method: 'DELETE' });
    showToast('Фото удалено.');
    await refreshSummary({ announce: false });
    await renderGallery(record);
  } catch (error) {
    showToast(`Не удалось удалить: ${error.message}`, 'error');
    button.disabled = false;
  }
}

/* ------------------------------------------------------------- загрузка */

function readPerformer() {
  try { return localStorage.getItem(PERFORMER_KEY) || ''; } catch { return ''; }
}

function writePerformer(value) {
  try { localStorage.setItem(PERFORMER_KEY, value); } catch { /* ignore */ }
}

function isSupportedFile(file) {
  const mime = String(file.type || '').toLowerCase();
  return SUPPORTED_TYPES.includes(mime) || ((!mime || mime === 'application/octet-stream') && /\.(jpe?g|png|webp)$/i.test(file.name || ''));
}

function scaleImage(file, maxEdge, quality) {
  if (typeof createImageBitmap !== 'function') return Promise.resolve(null);
  return createImageBitmap(file).then((bitmap) => new Promise((resolve) => {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) { bitmap.close(); resolve(null); return; }
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality);
  })).catch(() => null);
}

function pickFiles(event) {
  const chosen = [...(event.target.files || [])];
  const room = mkdFilesToSend(chosen.length, state.photos.length);
  const accepted = [];
  for (const file of chosen) {
    if (accepted.length >= room) break;
    if (!isSupportedFile(file)) { showToast(`«${file.name}»: нужен JPEG, PNG или WEBP (HEIC не подходит).`, 'error'); continue; }
    if (file.size > MAX_FILE_BYTES) { showToast(`«${file.name}» больше 20 МБ.`, 'error'); continue; }
    accepted.push(file);
  }
  if (chosen.length > room) showToast(`Выбрано ${chosen.length}, но места осталось на ${room} — лишние не отправятся.`, 'error');
  state.files = accepted;
  const previews = element('paPreviews');
  previews.replaceChildren();
  releaseUrls(state.previewUrls);
  for (const file of accepted) {
    const url = URL.createObjectURL(file);
    state.previewUrls.push(url);
    const image = document.createElement('img');
    image.className = 'mkd-preview';
    image.alt = file.name;
    image.src = url;
    previews.appendChild(image);
  }
  updateUploadButton();
}

function requestGps() {
  const note = element('paGpsNote');
  if (!navigator.geolocation) { note.textContent = 'Этот браузер не умеет определять координаты.'; return; }
  note.textContent = 'Определяем координаты…';
  navigator.geolocation.getCurrentPosition((position) => {
    state.gps = { lat: position.coords.latitude, lon: position.coords.longitude, accuracy: position.coords.accuracy, capturedAt: new Date().toISOString() };
    note.textContent = `GPS ${formatCoordinates(state.gps.lat, state.gps.lon)} · точность около ${Math.round(state.gps.accuracy)} м.`;
  }, (error) => {
    state.gps = null;
    note.textContent = `GPS не получен: ${error.message || 'разрешение не выдано'}. Фото можно отправить и без координат.`;
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
}

function idempotencyKey(record, file) {
  const random = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  if (!file.mkdKey) file.mkdKey = `mkd-${record.id.replace(/[^A-Za-z0-9]/g, '')}-${random}`;
  return file.mkdKey;
}

async function sendPhotos(event) {
  event.preventDefault();
  const record = state.selected;
  const performer = element('paPerformer').value.trim();
  if (!record || !state.files.length || !performer) return;
  writePerformer(performer);
  state.sending = true;
  const status = element('paUploadState');
  status.dataset.state = 'sending';
  updateUploadButton();
  const total = state.files.length;
  let sent = 0;
  try {
    for (const file of [...state.files]) {
      status.textContent = `Отправляется фото ${sent + 1} из ${total}… не закрывайте страницу.`;
      const form = new FormData();
      form.append('file', (await scaleImage(file, 1600, 0.84)) || file, file.name || 'photo.jpg');
      const thumbnail = await scaleImage(file, THUMBNAIL_MAX_EDGE, 0.7);
      if (thumbnail) form.append('thumbnail', thumbnail, 'preview.jpg');
      form.append('sourceId', record.id);
      form.append('performer', performer);
      form.append('comment', element('paComment').value.trim());
      if (state.gps) {
        form.append('gpsLat', state.gps.lat);
        form.append('gpsLon', state.gps.lon);
        form.append('gpsAccuracyM', state.gps.accuracy);
        form.append('capturedAt', state.gps.capturedAt);
      }
      await apiJson('/mkd/photos', { method: 'POST', headers: { 'Idempotency-Key': idempotencyKey(record, file) }, body: form });
      // Отправленное убираем сразу: при сбое повтор дошлёт только остальное.
      state.files = state.files.filter((item) => item !== file);
      sent += 1;
    }
    state.sending = false;
    resetForm();
    status.dataset.state = 'review';
    status.textContent = `Прикреплено фото: ${sent}.`;
    showToast(`Фото первого этажа прикреплены: ${sent}.`);
  } catch (error) {
    state.sending = false;
    status.dataset.state = 'error';
    status.textContent = `Отправлено ${sent} из ${total}. Ошибка: ${error.message}. Нажмите «Прикрепить» ещё раз — дублей не будет.`;
  }
  await refreshSummary({ announce: false });
  await renderGallery(record);
}

/* -------------------------------------------------------------- выгрузки */

async function downloadExcel() {
  const district = element('paDistrictFilter').value;
  const query = district ? `?district=${encodeURIComponent(district)}` : '';
  try {
    showToast('Готовим Excel…');
    const response = await api(`/mkd/export.xlsx${query}`);
    if (!response.ok) throw new Error(`Сервис ответил ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = 'sao-mkd-first-floor.xlsx';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('Excel готов.');
  } catch (error) {
    showToast(`Не удалось выгрузить Excel: ${error.message}`, 'error');
  }
}

async function downloadArchive() {
  const district = element('paDistrictFilter').value;
  const query = district ? `?district=${encodeURIComponent(district)}` : '';
  try {
    showToast('Собираем архив фото первых этажей… это может занять несколько минут.');
    let job = await apiJson(`/mkd/photos.zip/prepare${query}`, { method: 'POST' });
    while (job.status === 'building') {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      job = await apiJson(`/mkd/photos.zip/prepare/${job.id}`);
      element('paListCount').textContent = job.total
        ? `Собираем архив: ${number(job.photos)} из ${number(job.total)} фото`
        : 'Собираем архив…';
    }
    if (job.status !== 'ready') throw new Error(job.error || 'архив не собрался');
    const link = document.createElement('a');
    link.href = `${apiBase()}/reports/photos.zip/file/${encodeURIComponent(job.name)}?ticket=${encodeURIComponent(job.ticket)}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast(`Архив готов: ${number(job.photos)} фото.`);
  } catch (error) {
    showToast(`Не удалось собрать архив: ${error.message}`, 'error');
  }
  renderList();
}

/* ------------------------------------------------------------- разметка */

function setPanelOpen(open) {
  element('paSide').dataset.open = open ? 'true' : 'false';
  element('paPanelBackdrop').dataset.open = open ? 'true' : 'false';
  element('paPanelToggle').setAttribute('aria-expanded', String(open));
}

function shell() {
  document.body.insertAdjacentHTML('afterbegin', `
<div class="pa-app">
  <header class="pa-topbar">
    <div class="pa-brand">
      <span class="pa-brand-mark" aria-hidden="true">⌖</span>
      <span><strong id="paTitle">Подъезды · ${MKD_CATEGORY}</strong><small id="paSubtitle">Загружаем подъезды…</small></span>
    </div>
    <a class="pa-atlas-link" id="paBackLink" href="./entrances.html" hidden>← Фотофиксация</a>
    <nav class="pa-datasets" id="paDatasets" role="tablist" aria-label="Категория"></nav>
    <div class="pa-session">
      <form class="pa-login" id="paLoginForm">
        <label class="pa-sr" for="paLoginInput">Логин отдела МКД</label>
        <input id="paLoginInput" type="text" placeholder="Логин отдела МКД" autocomplete="username">
        <label class="pa-sr" for="paPasswordInput">Пароль</label>
        <input id="paPasswordInput" type="password" placeholder="Пароль" autocomplete="current-password">
        <button type="submit" class="pa-btn pa-btn-primary" id="paLoginButton">Войти</button>
      </form>
      <button type="button" class="pa-btn" id="paLogoutButton" hidden>Выйти</button>
      <p class="pa-session-state" id="paSessionState">Проверяем сессию…</p>
    </div>
  </header>

  <main class="pa-main">
    <section class="pa-register" id="paRegisterPanel">
      <aside class="pa-side" id="paSide" aria-label="Сводка, фильтры и список подъездов">
        <div class="pa-side-head">
          <strong>Список и фильтры</strong>
          <button type="button" class="pa-btn pa-panel-close" id="paPanelClose">Закрыть</button>
        </div>
        <div class="pa-summary" id="paSummary"></div>
        <section class="pa-dashboard" id="paDashboard" aria-labelledby="paDashboardTitle" hidden>
          <h2 class="pa-dashboard-title" id="paDashboardTitle">Районы · ${MKD_CATEGORY}</h2>
          <div class="pa-board" id="paDistrictBoard" role="list"></div>
        </section>
        <div class="pa-filters">
          <div>
            <label class="pa-label" for="paSearch">Поиск по адресу, УНОМ и номеру подъезда</label>
            <input class="pa-input" id="paSearch" type="search" placeholder="Начните вводить…" autocomplete="off">
          </div>
          <div>
            <label class="pa-label" for="paDistrictFilter">Район</label>
            <select class="pa-input" id="paDistrictFilter"><option value="">Весь САО</option></select>
          </div>
          <div>
            <label class="pa-label" for="paStatusFilter">Фото первого этажа</label>
            <select class="pa-input" id="paStatusFilter">
              <option value="all">Все подъезды</option>
              <option value="without">Без фото — осталось сделать</option>
              <option value="with">С фото</option>
            </select>
          </div>
        </div>
        <div class="pa-exports" id="paExports" hidden>
          <button type="button" class="pa-btn" id="paExportXlsx">Excel: первые этажи</button>
          <button type="button" class="pa-btn" id="paExportPhotos">Архив фото (ZIP)</button>
        </div>
        <p class="pa-list-head" id="paListCount" role="status">Загружаем подъезды…</p>
        <div class="pa-list" id="paList" role="list"></div>
      </aside>
      <section class="pa-map-panel" aria-label="Интерактивная карта">
        <div id="paMap" role="application" aria-label="Карта подъездов"></div>
        <p class="pa-map-status" id="paMapStatus">Загрузка карты…</p>
        <p class="pa-legend" id="paLegend"></p>
        <button type="button" class="pa-btn pa-panel-toggle" id="paPanelToggle" aria-expanded="false" aria-controls="paSide">Список и фильтры</button>
      </section>
    </section>
    <div class="pa-panel-backdrop" id="paPanelBackdrop" data-open="false"></div>
  </main>
</div>

<dialog class="pa-dialog" id="paDialog" aria-labelledby="paDialogTitle">
  <form method="dialog" class="pa-dialog-close-form"><button class="pa-close" aria-label="Закрыть карточку подъезда">×</button></form>
  <h2 id="paDialogTitle"></h2>
  <p class="pa-dialog-subtitle" id="paDialogSubtitle"></p>
  <h3>${MKD_CATEGORY} — фото</h3>
  <div class="pa-gallery" id="paGallery"></div>
  <p class="pa-note" id="paReadOnlyNote" hidden>Префектура видит фото первых этажей только для просмотра.</p>
  <form class="pa-upload" id="paUploadForm">
    <h3>Прикрепить фото первого этажа</h3>
    <label for="paFile">Фото (JPEG, PNG или WEBP), можно несколько — до ${MKD_PHOTO_LIMIT} на подъезд</label>
    <input class="pa-file" id="paFile" type="file" accept="image/jpeg,image/png,image/webp" multiple>
    <div class="mkd-previews" id="paPreviews"></div>
    <p class="pa-note" id="paLimitNote"></p>
    <label for="paPerformer">Исполнитель</label>
    <input id="paPerformer" type="text" maxlength="120" placeholder="Фамилия, инициалы" autocomplete="name">
    <label for="paComment">Комментарий</label>
    <textarea id="paComment" maxlength="1000" placeholder="Например: холл, почтовые ящики…"></textarea>
    <div class="pa-upload-actions">
      <button type="button" class="pa-btn" id="paGpsButton">Определить GPS</button>
      <button type="submit" class="pa-btn pa-btn-primary" id="paSave" disabled>Прикрепить</button>
    </div>
    <p class="pa-note" id="paGpsNote">GPS не обязателен.</p>
    <p class="pa-note" id="paUploadState" role="status" data-state="idle">Не отправлено.</p>
  </form>
  <h3>Данные подъезда</h3>
  <div class="pa-data" id="paDialogData"></div>
</dialog>

<p class="pa-toast" id="paToast" role="status" aria-live="polite"></p>`);
}

function debounce(callback, delay) {
  let timer = null;
  return () => { clearTimeout(timer); timer = setTimeout(callback, delay); };
}

function bindEvents() {
  element('paLoginForm').addEventListener('submit', submitLogin);
  element('paLogoutButton').addEventListener('click', submitLogout);
  element('paPanelToggle').addEventListener('click', () => setPanelOpen(true));
  element('paPanelClose').addEventListener('click', () => setPanelOpen(false));
  element('paPanelBackdrop').addEventListener('click', () => setPanelOpen(false));
  element('paSearch').addEventListener('input', debounce(() => onFilterChange(), 220));
  element('paStatusFilter').addEventListener('change', () => onFilterChange());
  element('paDistrictFilter').addEventListener('change', () => {
    onFilterChange({ fit: true });
    fitMapToRecords(currentRecords());
  });
  element('paExportXlsx').addEventListener('click', downloadExcel);
  element('paExportPhotos').addEventListener('click', downloadArchive);
  element('paFile').addEventListener('change', pickFiles);
  element('paPerformer').addEventListener('input', updateUploadButton);
  element('paGpsButton').addEventListener('click', requestGps);
  element('paUploadForm').addEventListener('submit', sendPhotos);
  element('paDialog').addEventListener('close', () => {
    releaseUrls(state.objectUrls);
    releaseUrls(state.previewUrls);
    state.selected = null;
    state.photos = [];
    if (state.lastFocused && document.contains(state.lastFocused)) state.lastFocused.focus();
  });
}

export async function startMkdApp() {
  shell();
  bindEvents();
  try {
    await loadData();
  } catch (error) {
    element('paSubtitle').textContent = error.message;
    element('paListCount').textContent = 'Подъезды недоступны.';
    return;
  }
  document.title = `${MKD_CATEGORY} — подъезды САО · отдел МКД`;
  await restoreSession();
  await refreshSummary({ announce: false });
  if (window.ymaps) window.ymaps.ready(() => { state.mapReady = true; buildMap(); });
  else element('paMapStatus').textContent = 'Не загрузился API Яндекс Карт: проверьте интернет и ограничения ключа.';
}
