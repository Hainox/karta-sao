window.initParkDigitizationLayer = function ({
  container, map, card, district, apiRequest, getUser, preparePointPhoto, centerSelection, popover,
  arrowSvg, bearing, exitOtherEditing, featureStyle,
}) {
  const BASE = '/object-photo-points/parks';
  const COLOR = '#007b80';
  const PHOTO_LABELS = { empty: 'Нет фото', pending: 'На проверке', accepted: 'Принято', rework: 'На доработке' };
  const PHOTO_COLORS = { pending: '#e5a100', accepted: '#087550', rework: '#c92448' };
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    if (className) el.className = className;
    return el;
  };
  const button = (text, run, className) => {
    const el = node('button', text, className);
    el.type = 'button';
    el.addEventListener('click', run);
    return el;
  };
  const canEdit = () => getUser()?.role === 'prefecture_admin';

  const section = node('div');
  section.id = 'parkDigitizationLayer';
  section.hidden = true;
  const label = node('label', '', 'layer-row off');
  const checkbox = node('input');
  checkbox.type = 'checkbox';
  const swatch = node('span', '', 'swatch');
  swatch.style.background = COLOR;
  const count = node('span', '—', 'count');
  label.append(checkbox, swatch, node('span', 'Оцифровка Парковых территорий', 'label'), count);
  const controls = node('div', '', 'park-controls');
  controls.hidden = true;
  const select = node('select');
  select.setAttribute('aria-label', 'Парковая территория');
  const facts = node('div', '', 'shoot-hint');
  const status = node('div', '', 'shoot-hint');
  status.setAttribute('role', 'status');
  const list = node('details', '', 'shoot-list-box');
  const rows = node('div', '', 'shoot-list');
  list.append(node('summary', 'Точки выбранного парка'), rows);
  const add = button('Добавить точку', () => {
    if (!selectedPark()) { status.textContent = 'Сначала выберите парк.'; return; }
    if (mode === 'new' || active?.isNew) {
      closeCard();
      status.textContent = 'Добавление отменено.';
      return;
    }
    exitOtherEditing();
    closeCard();
    mode = 'new';
    add.textContent = 'Отменить добавление';
    status.textContent = 'Нажмите на карту в месте съёмки.';
    map.getContainer?.().style.setProperty('cursor', 'crosshair');
  }, 'hud-btn');
  const reload = button('Обновить слой', () => void load(), 'hud-btn');
  const actions = node('div', '', 'pin-actions');
  actions.append(add, reload);
  controls.append(select, facts, actions, status, list);
  section.append(label, controls);
  container.after(section);

  let parks = [];
  let destinations = [];
  let points = [];
  let parkId = '';
  let overlays = [];
  let active = null;
  let mode = null;
  let request = null;
  let draftMarker = null;
  let linkedPoint = new URLSearchParams(location.search).get('parkPoint');
  const selectedPark = () => parks.find(park => park.id === parkId);
  const framePath = (point) => BASE + '/frames/' + point.slot.id;
  const pointPath = (point) => BASE + '/points/' + point.id;

  function resetMode() {
    mode = null;
    map.getContainer?.().style.removeProperty('cursor');
  }

  function clearCard() {
    resetMode();
    if (draftMarker) map.removeChild(draftMarker);
    draftMarker = null;
    if (active?.point) document.querySelector('[data-park-point="' + active.point.id + '"]')?.style.removeProperty('visibility');
    if (active?.photoUrl) URL.revokeObjectURL(active.photoUrl);
    active = null;
    add.textContent = 'Добавить точку';
  }
  function closeCard() {
    if (active && card.contains(active.content)) popover.close();
    else clearCard();
  }
  popover.onClose(clearCard);
  new MutationObserver(() => {
    if (active && !card.contains(active.content)) clearCard();
  }).observe(card, { childList: true });

  function parkAsu(park) {
    const referenceIds = [...new Set(park.source_objects.map(row => row.asuIdInExcel).filter(Boolean))];
    if (park.registry_status === 'absent_in_source') return 'По списку отсутствует в АСУ ОДС';
    if (park.asu_ids.length) {
      return 'АСУ ОДС · ' + park.asu_ids.join(', ') + (park.registry_status === 'conflict' ? ' · сверить район' : '');
    }
    return referenceIds.length ? 'ID из Excel · ' + referenceIds.join(', ') + ' · сверить' : 'ID АСУ ОДС не подтверждён';
  }
  function focusPark(park) {
    if (!park?.geometry) return;
    const polygons = park.geometry.type === 'Polygon' ? [park.geometry.coordinates] : park.geometry.coordinates;
    const bounds = [[180, 90], [-180, -90]];
    for (const polygon of polygons) for (const [lng, lat] of polygon[0]) {
      bounds[0][0] = Math.min(bounds[0][0], lng);
      bounds[0][1] = Math.min(bounds[0][1], lat);
      bounds[1][0] = Math.max(bounds[1][0], lng);
      bounds[1][1] = Math.max(bounds[1][1], lat);
    }
    map.update({ location: { bounds, duration: 250 } });
  }
  function choosePark(id, focus = false) {
    closeCard();
    parkId = id;
    select.value = id;
    status.textContent = '';
    draw();
    if (focus) focusPark(selectedPark());
  }
  select.addEventListener('change', () => choosePark(select.value, true));

  function marker(point, park, isDraft) {
    const { YMapMarker } = window.ymaps3;
    const el = node(isDraft ? 'span' : 'button', '', 'shoot-marker sidewalk-shoot' + (isDraft ? ' preview' : ''));
    const dot = node('span', '', 'shoot-dot');
    dot.style.background = PHOTO_COLORS[point.slot.status] || COLOR;
    dot.style.boxShadow = '0 0 0 2px #00585c';
    el.append(dot);
    if (point.slot.azimuth != null) el.append(arrowSvg(point.slot.azimuth, COLOR, '#00585c'));
    if (isDraft) {
      el.style.pointerEvents = 'none';
    } else {
      el.type = 'button';
      el.dataset.parkPoint = point.id;
      el.setAttribute('aria-label', park.name + ' · ' + PHOTO_LABELS[point.slot.status] + ' · ' + point.slot.azimuth + '°');
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!mode) openPoint(point, park);
      });
    }
    return new YMapMarker({ coordinates: point.coordinates, zIndex: isDraft ? 65 : 42 }, el);
  }
  function draw() {
    overlays.forEach(item => map.removeChild(item));
    overlays = [];
    if (!checkbox.checked || !canEdit()) return;
    const park = selectedPark();
    const visiblePoints = points.filter(point => point.parkId === parkId);
    count.textContent = points.length.toLocaleString('ru-RU');
    facts.replaceChildren();
    if (park) {
      facts.append(node('b', park.name), node('div', parkAsu(park)));
      facts.append(node('div', park.geometry_source || 'Контур отсутствует'));
      if (park.registry_status === 'absent_in_source') {
        const numbers = [...new Set(park.source_objects.map(row => row.asuIdInExcel).filter(Boolean))];
        if (numbers.length) facts.append(node('div', 'Номер из исходного списка · ' + numbers.join(', ')));
      }
      if (park.needs_review) facts.append(node('div', 'Требуется сверка территории.'));
    } else facts.textContent = parks.length ? 'Выберите парк в списке или на карте.' : 'В реестре нет парков этого района.';
    const { YMapFeature } = window.ymaps3;
    for (const item of parks) {
      if (!item.geometry) continue;
      const chosen = item.id === parkId;
      overlays.push(new YMapFeature({
        id: 'park-digitization:' + item.id,
        geometry: item.geometry,
        style: featureStyle(COLOR, chosen ? 0.18 : 0.07, false, { color: COLOR, width: chosen ? 2.4 : 1.2 }),
        onClick: () => { if (!mode) choosePark(item.id); },
      }));
    }
    visiblePoints.forEach(point => overlays.push(marker(point, park, false)));
    overlays.forEach(item => map.addChild(item));
    list.hidden = !park;
    rows.replaceChildren(...visiblePoints.map((point, index) => button(
      'Точка ' + (index + 1) + ' · ' + point.slot.azimuth + '° · ' + PHOTO_LABELS[point.slot.status],
      () => openPoint(point, park, { focus: true }), 'shoot-item',
    )));
    if (park && !visiblePoints.length) rows.textContent = 'Точек пока нет.';
    add.disabled = !parks.length;
  }

  function updatePoint(point) {
    points = points.some(item => item.id === point.id)
      ? points.map(item => item.id === point.id ? point : item)
      : [...points, point];
    draw();
  }
  function changeRequest(path, method, body) {
    return apiRequest(path, { method, body: JSON.stringify(body) }).then(response => response.json());
  }
  async function load() {
    request?.abort();
    const controller = new AbortController();
    request = controller;
    closeCard();
    label.classList.toggle('off', !checkbox.checked);
    controls.hidden = !checkbox.checked;
    if (controls.hidden || !canEdit()) { draw(); return; }
    status.textContent = 'Загружаем парки…';
    add.disabled = true;
    try {
      const response = await apiRequest(BASE + '/district?district=' + encodeURIComponent(district), { signal: controller.signal });
      const data = await response.json();
      if (request !== controller || !canEdit()) return;
      parks = data.parks;
      destinations = data.destinations || [];
      points = data.points;
      select.replaceChildren(new Option('Выберите парк', ''), ...parks.map(park => new Option(park.name, park.id)));
      const target = linkedPoint ? points.find(point => point.id === linkedPoint) : null;
      choosePark(target?.parkId ?? (parks.some(park => park.id === parkId) ? parkId : ''));
      if (linkedPoint) {
        linkedPoint = null;
        if (target) openPoint(target, selectedPark(), { focus: true });
        else status.textContent = 'Точка по ссылке не найдена в этом районе.';
      }
    } catch (error) {
      if (request !== controller || controller.signal.aborted) return;
      status.textContent = 'Слой не загружен. ' + error.message;
      add.disabled = !parks.length;
    } finally {
      if (request === controller) request = null;
    }
  }
  checkbox.addEventListener('change', () => void load());

  function showPhoto(point, content, message) {
    const slot = point.slot;
    const panel = node('div');
    content.append(panel);
    panel.append(node('p', PHOTO_LABELS[slot.status], 'pin-note'));
    if (slot.comment) panel.append(node('p', slot.comment, 'pin-note'));
    if (slot.photoId) {
      const photo = node('div');
      panel.append(photo);
      apiRequest(framePath(point) + '/photos/' + slot.photoId)
        .then(response => response.blob()).then(blob => {
          if (active?.content !== content || !photo.isConnected) return;
          active.photoUrl = URL.createObjectURL(blob);
          const image = node('img');
          image.alt = 'Фото точки съёмки';
          image.style.maxWidth = '100%';
          image.src = active.photoUrl;
          photo.append(image);
        }).catch(() => { photo.textContent = 'Не удалось открыть фото.'; });
    }
    if (['empty', 'rework'].includes(slot.status)) {
      const input = node('input');
      input.type = 'file';
      input.hidden = true;
      input.accept = 'image/jpeg,image/png,image/webp';
      const upload = button('Загрузить фото', () => input.click(), 'primary');
      panel.append(input, upload);
      input.addEventListener('change', async () => {
        if (!input.files[0] || active?.content !== content) return;
        upload.disabled = true;
        message.textContent = 'Загружаем фото…';
        try {
          const file = await preparePointPhoto(input.files[0]);
          if (active?.content !== content || !canEdit()) return;
          const response = await apiRequest(framePath(point) + '/photo', {
            method: 'PUT', headers: { 'Content-Type': file.type, 'X-Photo-Filename': encodeURIComponent(file.name) }, body: file,
          });
          const { photo } = await response.json();
          if (!canEdit()) return;
          const updated = { ...point, slot: { ...slot, photoId: photo.id, status: photo.status, comment: '' } };
          if (active?.content === content) openPoint(updated, selectedPark());
          if (points.find(item => item.id === point.id)?.revision === point.revision) updatePoint(updated);
          else void load();
        } catch (error) { message.textContent = 'Фото не загружено. ' + error.message; }
        finally { input.value = ''; upload.disabled = false; }
      });
    }
    if (slot.status !== 'pending') return;
    const comment = node('textarea');
    comment.placeholder = 'Причина возврата';
    comment.setAttribute('aria-label', 'Причина возврата');
    comment.maxLength = 2000;
    const reviewActions = node('div', '', 'pin-actions');
    async function review(decision) {
      reviewActions.querySelectorAll('button').forEach(control => { control.disabled = true; });
      try {
        const { photo } = await changeRequest(framePath(point) + '/photos/' + slot.photoId + '/review', 'POST', { decision, comment: comment.value });
        if (!canEdit()) return;
        const updated = { ...point, slot: { ...slot, status: photo.status === 'rejected' ? 'rework' : photo.status, comment: comment.value.trim() } };
        if (active?.content === content) openPoint(updated, selectedPark());
        if (points.find(item => item.id === point.id)?.revision === point.revision) updatePoint(updated);
        else void load();
      } catch (error) { message.textContent = error.message; }
      finally { reviewActions.querySelectorAll('button').forEach(control => { control.disabled = false; }); }
    }
    reviewActions.append(button('Принять', () => review('accepted')), button('На доработку', () => review('rejected')));
    panel.append(comment, reviewActions);
  }

  function openPoint(point, park, { isNew = false, focus = false } = {}) {
    if (!canEdit() || !park) return;
    clearCard();
    if (focus) centerSelection(point.coordinates, 18);
    popover.open({
      coordinates: point.coordinates, kind: 'park', title: park.name,
      subtitle: parkAsu(park), heading: point.slot.azimuth, editing: true,
    });
    const content = node('section', '', 'pin-section');
    const message = node('p', '', 'pin-note');
    message.setAttribute('role', 'status');
    content.append(node('h3', isNew ? 'Новая точка съёмки' : 'Фотослот · ' + point.slot.azimuth + '°'), message);
    card.replaceChildren(content);
    active = { content, point, isNew };
    if (!isNew) showPhoto(point, content, message);
    const coords = node('p', '', 'pin-note');
    const angle = node('input');
    angle.type = 'number';
    angle.min = '0';
    angle.max = '359.99';
    angle.step = '0.01';
    angle.value = point.slot.azimuth ?? '';
    const angleLabel = node('label', 'Азимут, ° ');
    angleLabel.append(angle);
    const reason = node('textarea');
    reason.maxLength = 500;
    reason.placeholder = 'Примечание к точке';
    reason.setAttribute('aria-label', 'Обоснование положения точки');
    reason.value = point.locationReason || '';
    const destination = node('select');
    destination.setAttribute('aria-label', 'Принадлежность точки');
    destination.replaceChildren(...destinations.map(item => new Option(item.name + ' · ' + item.district, item.id)));
    destination.value = park.id;
    let coordinates = point.coordinates;
    coords.textContent = coordinates.map(value => value.toFixed(6)).join(', ');
    const form = node('div', '', 'park-edit-form');
    const updateDraft = () => {
      popover.setHeading(angle.value === '' ? null : Number(angle.value));
      coords.textContent = coordinates.map(value => value.toFixed(6)).join(', ');
      if (draftMarker) map.removeChild(draftMarker);
      draftMarker = marker({ coordinates, slot: { azimuth: angle.value === '' ? null : Number(angle.value) } }, park, true);
      map.addChild(draftMarker);
      document.querySelector('[data-park-point="' + point.id + '"]')?.style.setProperty('visibility', 'hidden');
    };
    active.onMapClick = (next) => {
      if (mode === 'move') {
        if (next.some((value, index) => value !== coordinates[index])) reason.value = '';
        coordinates = next;
        popover.setAnchor(next);
      } else if (Math.hypot(next[0] - coordinates[0], next[1] - coordinates[1]) > 0.000001) {
        angle.value = (Math.round(bearing(coordinates, next) * 100) / 100) % 360;
      } else return;
      resetMode();
      message.textContent = 'Положение и направление сохраняются кнопкой «Сохранить».';
      updateDraft();
    };
    angle.addEventListener('input', updateDraft);
    destination.addEventListener('change', () => { reason.value = ''; });
    const controls = node('div', '', 'pin-actions');
    const pick = (type, text) => {
      exitOtherEditing();
      mode = type;
      message.textContent = text;
    };
    const save = button('Сохранить', async () => {
      const azimuth = Number(angle.value);
      if (angle.value === '' || !angle.validity.valid) { message.textContent = 'Укажите азимут от 0° до 359,99°.'; return; }
      const reassigned = destination.value !== park.id;
      if (reassigned && !window.confirm('Перевести точку в парк «' + destination.selectedOptions[0].textContent + '»? Фотослот и снимки последуют за точкой.')) return;
      resetMode();
      const disabled = [];
      for (const control of content.querySelectorAll('button, input, textarea, select')) {
        if (!control.disabled) { disabled.push(control); control.disabled = true; }
      }
      const input = { coordinates, azimuth, locationReason: reason.value, parkId: destination.value };
      try {
        const data = isNew
          ? await changeRequest(BASE + '/points', 'POST', { ...input, district, id: point.id })
          : await changeRequest(pointPath(point), 'PATCH', { ...input, revision: point.revision, confirmReassignment: reassigned });
        if (!canEdit()) return;
        if (!parks.some(item => item.id === data.point.parkId)) {
          if (active?.content === content) closeCard();
          points = points.filter(item => item.id !== data.point.id);
          draw();
          status.textContent = 'Точка сохранена в другом районе. Откройте карту нового района.';
          return;
        }
        updatePoint(data.point);
        if (active?.content !== content) return;
        choosePark(data.point.parkId);
        openPoint(data.point, selectedPark());
        status.textContent = 'Точка сохранена.';
      } catch (error) { message.textContent = 'Точка не сохранена. ' + error.message; }
      finally { disabled.forEach(control => { control.disabled = false; }); }
    }, 'primary');
    controls.append(button('Перенести на карте', () => pick('move', 'Нажмите на новое место съёмки.')),
      button('Задать стрелку на карте', () => pick('angle', 'Нажмите в направлении будущего кадра.')), save);
    form.append(coords, angleLabel, reason,
      node('p', 'Точку можно ставить до 200 м за контуром парка. Если у парка нет контура, укажите обоснование.', 'pin-note'));
    if (!isNew && destinations.length > 1) {
      const owner = node('label', 'Парковая территория');
      owner.append(destination);
      form.append(owner);
    }
    form.append(controls);
    content.append(form);
    if (!isNew && point.slot.status === 'accepted') {
      form.append(node('p', 'Принятую точку нельзя удалить.', 'pin-note'));
    } else if (!isNew) controls.append(button('Удалить точку', async (event) => {
      const prompt = point.slot.photoId ? 'Убрать точку с карты? Снимки останутся в истории.' : 'Убрать точку с карты?';
      if (!window.confirm(prompt)) return;
      const remove = event.currentTarget;
      remove.disabled = true;
      try {
        await changeRequest(pointPath(point), 'DELETE', { revision: point.revision });
        if (active?.content === content) closeCard();
        points = points.filter(item => item.id !== point.id);
        draw();
        if (canEdit()) status.textContent = 'Точка удалена.';
      } catch (error) { message.textContent = 'Точка не удалена. ' + error.message; }
      finally { remove.disabled = false; }
    }, 'danger'));
    if (isNew) {
      mode = 'angle';
      add.textContent = 'Отменить добавление';
      message.textContent = 'Укажите направление кликом по карте или введите азимут.';
      updateDraft();
    }
  }

  return {
    handleMapClick(coordinates) {
      if (!mode || !canEdit() || !Array.isArray(coordinates)) return false;
      if (mode === 'new') {
        const park = selectedPark();
        if (park) openPoint({ id: crypto.randomUUID(), coordinates, slot: { azimuth: null } }, park, { isNew: true });
      } else active?.onMapClick(coordinates);
      return true;
    },
    isPicking: () => Boolean(mode),
    cancelPicking() { resetMode(); },
    setVisible(on) {
      section.hidden = !on || !canEdit();
      if (!section.hidden) {
        if (linkedPoint && !checkbox.checked) {
          checkbox.checked = true;
          void load();
        }
        return;
      }
      request?.abort();
      request = null;
      checkbox.checked = false;
      label.classList.add('off');
      controls.hidden = true;
      closeCard();
      parks = [];
      destinations = [];
      points = [];
      parkId = '';
      draw();
    },
  };
};
