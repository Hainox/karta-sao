const API = '/api/object-photo-points/sidewalk-test';
const FRAMES = API + '/avd/frames/';
const STATES = { empty: 'Нет фото', pending: 'На проверке', accepted: 'Принято', rework: 'На доработке' };
const PAGE = 40;
const byId = (id) => document.getElementById(id);
const number = (n) => n.toLocaleString('ru-RU');
function element(tag, text) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label, click) {
  const node = element('button', label);
  node.type = 'button';
  node.addEventListener('click', click);
  return node;
}

function direction(azimuth) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('class', 'avd-arrow');
  svg.setAttribute('viewBox', '0 0 52 52');
  svg.setAttribute('aria-hidden', 'true');
  const arrow = document.createElementNS(ns, 'path');
  arrow.setAttribute('d', 'M26 2 16 18h6v7h8v-7h6Z');
  arrow.setAttribute('fill', '#176bb0');
  arrow.setAttribute('stroke', '#fff');
  arrow.setAttribute('stroke-width', '2');
  arrow.setAttribute('transform', `rotate(${azimuth} 26 26)`);
  svg.append(arrow);
  return svg;
}

async function preparePhoto(file) {
  const max = 5 * 1024 * 1024;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('Выберите JPEG, PNG или WebP.');
  if (file.size <= max) return file;
  if (file.size > 40 * 1024 * 1024) throw new Error('Фото больше 40 МБ. Выберите снимок меньшего размера.');
  const image = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 2560 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * scale));
    canvas.height = Math.max(1, Math.round(image.height * scale));
    canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
    const compressed = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.84));
    if (!compressed || compressed.size > max) throw new Error('Не удалось уменьшить фото до 5 МБ.');
    return compressed;
  } finally { image.close(); }
}

export function mountAvdSidewalks({ map, ymaps, api }) {
  const panel = byId('sidewalks');
  const status = byId('avdStatus');
  const card = byId('avdPoint');
  const controls = byId('avdControls');
  const toggle = byId('avdLayer');
  const list = byId('avdList');
  const search = byId('avdSearch');
  const more = byId('avdMore');
  const retry = byId('avdRetry');
  let points = [];
  let district = '';
  let limit = PAGE;
  let selected = null;
  let arrow = null;
  let photoUrl = null;
  let markers = [];
  let clusterer = null;
  let request;
  let access = false;
  let clusterModule;
  const { YMapMarker } = ymaps;

  function resetFrame() {
    if (arrow) map.removeChild(arrow);
    arrow = null;
    if (photoUrl) URL.revokeObjectURL(photoUrl);
    photoUrl = null;
  }
  function close() {
    resetFrame();
    selected = null;
    card.hidden = true;
    card.replaceChildren();
  }
  const visiblePoints = () => points.filter(point => !district || point.district === district);
  function renderList() {
    const query = search.value.trim().toLowerCase();
    const matches = visiblePoints().filter(p => (p.id + ' ' + p.street).toLowerCase().includes(query));
    list.replaceChildren(...matches.slice(0, limit).map(point => button(
      point.street + ' · ' + point.id + (point.noSidewalk ? ' · Нет тротуара' : ''),
      () => openPoint(point),
    )));
    if (!matches.length) list.textContent = 'Подходящих точек нет.';
    more.hidden = matches.length <= limit;
  }

  function openPoint(point, activeSlotId = null, focus = true) {
    if (!access) return;
    close();
    selected = point;
    if (focus) map.update({ location: { center: point.coordinates, zoom: Math.max(17, map.zoom || 11), duration: 250 } });
    card.hidden = false;
    const content = element('div');
    const slotActions = element('div');
    const details = element('div', 'Выберите фотослот, чтобы увидеть направление съёмки.');
    const markStatus = element('p', point.noSidewalk ? 'На проверке: нет тротуара.' : '');
    markStatus.setAttribute('role', 'status');
    content.append(element('h3', point.street), element('p', point.district + ' · ' + point.id), slotActions, details);

    function select(slot, clicked) {
      if (!access || selected !== point) return;
      resetFrame();
      for (const node of slotActions.children) node.setAttribute('aria-pressed', String(node === clicked));
      arrow = new YMapMarker({ coordinates: point.coordinates, zIndex: 60 }, direction(slot.azimuth));
      map.addChild(arrow);
      const info = element('p', 'Направление: ' + number(slot.azimuth) + '° · ' + STATES[slot.status]);
      details.replaceChildren(info);
      if (slot.comment) details.append(element('p', 'Что исправить: ' + slot.comment));
      if (slot.photoId) {
        const target = element('div', 'Загружаем фото…');
        details.append(target);
        api.request(FRAMES + encodeURIComponent(slot.id) + '/photos/' + encodeURIComponent(slot.photoId))
          .then(response => response.blob()).then(blob => {
            if (!target.isConnected) return;
            photoUrl = URL.createObjectURL(blob);
            const image = element('img');
            image.src = photoUrl;
            image.alt = 'Фото слота ' + slot.id;
            target.replaceChildren(image);
          }).catch(() => { target.textContent = 'Не удалось открыть снимок.'; });
      }
      if (point.noSidewalk || !['empty', 'rework'].includes(slot.status)) return;
      const form = element('form');
      const input = element('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp';
      input.required = true;
      input.setAttribute('aria-label', 'Выбрать фотографию слота');
      const submit = element('button', 'Отправить на проверку');
      submit.type = 'submit';
      submit.className = 'primary';
      const feedback = element('p');
      feedback.setAttribute('role', 'status');
      form.append(input, submit, feedback);
      form.addEventListener('submit', async event => {
        event.preventDefault();
        const file = input.files[0];
        if (!file || !access || selected !== point || submit.disabled) return;
        submit.disabled = true;
        feedback.textContent = 'Отправляем фото…';
        try {
          const body = await preparePhoto(file);
          if (!access) return;
          const response = await api.request(FRAMES + encodeURIComponent(slot.id) + '/photo', {
            method: 'PUT', body, headers: {
              'Content-Type': body.type, 'X-Photo-Filename': encodeURIComponent(file.name),
            },
          });
          const { photo } = await response.json();
          Object.assign(slot, { photoId: photo.id, status: photo.status, comment: '' });
          if (selected === point && form.isConnected) openPoint(point, slot.id, false);
        } catch (error) { feedback.textContent = 'Фото не отправлено: ' + error.message; }
        finally { submit.disabled = false; }
      });
      details.append(form);
    }

    point.slots.forEach((slot, index) => {
      const choice = button('Кадр ' + (index + 1) + ' · ' + STATES[slot.status], () => select(slot, choice));
      choice.setAttribute('aria-pressed', 'false');
      slotActions.append(choice);
    });
    const mark = button(point.noSidewalk ? 'Снять пометку «Нет тротуара»' : 'Нет тротуара', async () => {
      if (mark.disabled || !access || selected !== point) return;
      mark.disabled = true;
      try {
        const response = await api.request(API + '/' + encodeURIComponent(point.id), {
          method: 'PATCH', body: JSON.stringify({ noSidewalk: !point.noSidewalk }),
        });
        point.noSidewalk = (await response.json()).point.noSidewalk === true;
        if (access) renderList();
        if (access) draw();
        if (selected === point) openPoint(point, null, false);
      } catch (error) { markStatus.textContent = 'Пометка не сохранена: ' + error.message; }
      finally { mark.disabled = false; }
    });
    content.append(mark, button('Закрыть точку', close), markStatus);
    card.replaceChildren(content);
    const index = point.slots.findIndex(slot => slot.id === activeSlotId);
    if (index !== -1) select(point.slots[index], slotActions.children[index]);
  }

  function removeMarkers() {
    if (clusterer) map.removeChild(clusterer);
    clusterer = null;
    for (const marker of markers) map.removeChild(marker);
    markers = [];
  }

  function makeMarker(point) {
    const dot = button(point.noSidewalk ? '!' : '', (event) => { event.stopPropagation(); openPoint(point); });
    dot.className = 'avd-dot' + (point.noSidewalk ? ' flagged' : '');
    dot.title = point.street + ' · ' + point.id;
    dot.setAttribute('aria-label', dot.title + (point.noSidewalk ? ' · Нет тротуара' : ''));
    return new YMapMarker({ coordinates: point.coordinates, zIndex: 40 }, dot);
  }

  async function draw() {
    removeMarkers();
    if (!access || !toggle.checked) return;
    // На обзоре округа вместо тысяч DOM-маркеров показываем группы точек.
    if (!clusterModule) {
      if (ymaps.import) {
        ymaps.import.registerCdn('https://cdn.jsdelivr.net/npm/{package}', ['@yandex/ymaps3-clusterer@0.0']);
        clusterModule = ymaps.import('@yandex/ymaps3-clusterer').catch(() => null);
      } else clusterModule = Promise.resolve(null);
    }
    const module = await clusterModule;
    if (!access || !toggle.checked) return;
    removeMarkers();
    const visible = visiblePoints();
    if (!module) {
      markers = visible.map(makeMarker);
      for (const marker of markers) map.addChild(marker);
      return;
    }
    const { YMapClusterer, clusterByGrid } = module;
    const byPoint = new Map(visible.map(point => [point.id, point]));
    clusterer = new YMapClusterer({
      method: clusterByGrid({ gridSize: 68 }),
      features: visible.map(point => ({ type: 'Feature', id: point.id, properties: {},
        geometry: { type: 'Point', coordinates: point.coordinates } })),
      marker: feature => makeMarker(byPoint.get(feature.id)),
      cluster: (coordinates, features) => {
        const node = button(number(features.length), event => {
          event.stopPropagation();
          map.update({ location: { center: coordinates, zoom: Math.min(20, (map.zoom || 11) + 2), duration: 250 } });
        });
        node.className = 'avd-dot';
        node.style.width = node.style.height = '34px';
        node.setAttribute('aria-label', 'Точек: ' + number(features.length) + '. Приблизить');
        return new YMapMarker({ coordinates, zIndex: 35 }, node);
      },
    });
    map.addChild(clusterer);
  }

  async function load() {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    status.textContent = 'Загружаем точки АвД САО…';
    retry.hidden = true;
    try {
      const response = await api.request(API + '/avd', { signal: controller.signal });
      const payload = await response.json();
      if (!access || request !== controller) return;
      points = payload.points;
      status.textContent = number(points.length) + ' точек · ' + number(points.reduce((sum, point) => sum + point.slots.length, 0)) + ' фотослотов';
      controls.hidden = false;
      renderList();
      await draw();
    } catch (error) {
      if (request !== controller || !access) return;
      status.textContent = 'Не удалось загрузить точки: ' + error.message;
      retry.hidden = false;
    }
  }

  retry.addEventListener('click', load);
  toggle.addEventListener('change', () => { if (!toggle.checked) close(); draw(); });
  search.addEventListener('input', () => { limit = PAGE; renderList(); });
  more.addEventListener('click', () => { limit += PAGE; renderList(); });
  return {
    setAccess(value) {
      if (access === value) return;
      access = value;
      panel.hidden = !access;
      if (access) load();
      else {
        request?.abort();
        request = null;
        close();
        removeMarkers();
        controls.hidden = true;
        points = [];
        list.replaceChildren();
      }
    },
    setDistrict(value) {
      district = value;
      if (!access) return;
      if (selected && district && selected.district !== district) close();
      limit = PAGE;
      renderList();
      draw();
    },
  };
}
