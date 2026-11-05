// Точки съёмки тротуаров у МКД: черновая расстановка из
// projects/sidewalk-photo-points/work/build_sidewalk_photo_points.py.
// Свой район и префектура видят фотослой: страница вызывает setVisible
// при каждом входе и выходе. Точки берутся со службы фото, где префектура их
// переносит, поворачивает и удаляет. Если служба недоступна или точки туда ещё
// не загружены, показывается опубликованный файл слоя — без правок.
window.initSidewalkShootLayer = function ({ map, slug, district, apiRequest, escapeHtml, centerSelection, popover, getUser, preparePointPhoto, editor }) {
  const container = document.getElementById('sidewalkShootLayer');
  const card = document.getElementById('card');
  const API = '/object-photo-points/sidewalks';
  const testLayer = initSidewalkTestLayer({ container, map, card, district, apiRequest, centerSelection, popover, getUser, editor, arrowSvg, preparePointPhoto });
  const STEP = 15;
  let points = [];
  let editable = false;
  let visible = false;
  let isOn = false;
  let current = null;
  const keyOf = (point) => 'sw:' + point.id;
  const canEdit = () => editable && getUser?.()?.role === 'prefecture_admin';

  const fromServer = (p) => ({ id: p.id, point_no: p.point_no, address: p.address, side: p.side, role: p.role,
    also_covers: p.also_covers, status: p.status, heading: Number(p.heading), lng: Number(p.longitude), lat: Number(p.latitude),
    photo_state: p.photo_state || 'empty' });
  const PHOTO_LABELS = { empty: 'Нет фото', pending: 'На проверке', accepted: 'Принято', rework: 'На доработке' };
  const when = (value) => value ? new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  let photoUrl = null;
  const fromFile = (f) => ({ id: f.properties.point_no, point_no: f.properties.point_no, address: f.properties.address,
    side: f.properties.side, role: f.properties.role, also_covers: f.properties.also_covers, status: f.properties.status,
    heading: Number(f.properties.azimuth), lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });

  function arrowSvg(heading, fill = '#f28c18', outline = '#8a4300') {
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'shoot-arrow');
    arrow.setAttribute('viewBox', '0 0 64 80');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.style.transform = 'rotate(' + heading + 'deg)';
    arrow.innerHTML = `<path d="M32 4 L14 26 L25 26 L25 70 L39 70 L39 26 L50 26 Z" fill="none" stroke="white" stroke-width="8" stroke-linejoin="round"/><path d="M32 4 L14 26 L25 26 L25 70 L39 70 L39 26 L50 26 Z" fill="${fill}" stroke="${outline}" stroke-width="3" stroke-linejoin="round"/>`;
    return arrow;
  }

  function markerFor(point) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'shoot-marker sidewalk-shoot';
    if (point.photo_state && point.photo_state !== 'empty') el.dataset.photoState = point.photo_state;
    el.title = `Тротуар ${point.point_no} · ${point.address} · ${point.heading}°`;
    el.innerHTML = '<span class="shoot-dot"></span>';
    el.append(arrowSvg(point.heading));
    point._arrow = el.lastChild;
    point._element = el;
    const key = keyOf(point);
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      if (editor?.takeSuppressedClick(key)) return;
      centerSelection([point.lng, point.lat]);
      openCard(point);
    });
    // Выбранную точку префектура тащит прямо мышью — ручки даёт districts/point-editor.js.
    const marker = new window.ymaps3.YMapMarker({
      coordinates: [point.lng, point.lat],
      draggable: Boolean(editor?.isSelected(key)) && canEdit(),
      ...(editor && canEdit() ? editor.dragHandlers(key) : {}),
    }, el);
    editor?.attach(key, el, { coordinates: [point.lng, point.lat], heading: point.heading });
    return marker;
  }

  function renderList() {
    const box = container.querySelector('[data-sidewalk-list]');
    if (!box) return;
    box.closest('details').hidden = !isOn || !visible;
    const sorted = [...points].sort((a,b) => String(a.point_no).localeCompare(String(b.point_no), 'ru', { numeric: true }));
    box.replaceChildren();
    for (const point of sorted) {
      const row = document.createElement('button');
      row.type = 'button'; row.className = 'shoot-item';
      row.style.cssText = 'width:100%;text-align:left;background:white';
      row.dataset.state = point.photo_state || 'empty';
      row.innerHTML = '<b>' + escapeHtml(point.point_no) + '</b><span class="deg">' + Math.round(point.heading) + '°</span><span class="chip">' + (PHOTO_LABELS[point.photo_state || 'empty']) + '</span>';
      row.title = point.address || '';
      row.onclick = () => { centerSelection([point.lng, point.lat]); openCard(point); };
      box.append(row);
    }
    if (!sorted.length) box.textContent = 'Точек пока нет.';
  }

  function draw() {
    renderList();
    for (const p of points) { if (p._marker) { try { map.removeChild(p._marker); } catch (_) { /* уже снят */ } p._marker = null; } }
    if (!isOn || !visible) return;
    for (const p of points) { p._marker = markerFor(p); map.addChild(p._marker); }
    // Точки в одном месте разводим на экране, чтобы каждую можно было нажать.
    window.spreadStackedPoints?.(points.map((p) => ({ lng: p.lng, lat: p.lat, heading: p.heading, element: p._element })));
  }

  function redrawOne(point) {
    renderList();
    if (point._marker) { try { map.removeChild(point._marker); } catch (_) { /* уже снят */ } }
    point._marker = null;
    if (!isOn || !visible || !points.includes(point)) return;
    point._marker = markerFor(point);
    map.addChild(point._marker);
  }

  function setStatus(text) {
    const box = card.querySelector('[data-sw-status]');
    if (box) box.textContent = text;
  }

  /** Правка из ручек на карте: перенос или поворот уходит на сервер сразу. */
  async function save(point, body) {
    const response = await apiRequest(`${API}/${point.id}`, { method: 'PATCH', body: JSON.stringify(body) });
    const photoState = point.photo_state;
    Object.assign(point, fromServer((await response.json()).point), { photo_state: photoState });
    redrawOne(point);
    if (current === point) {
      const deg = card.querySelector('[data-sw-heading]');
      if (deg) deg.textContent = point.heading + '°';
    }
  }

  function openCard(point, message = '') {
    current = point;
    const e = escapeHtml;
    const editing = canEdit();
    popover.open({ coordinates: [point.lng, point.lat], kind: 'sidewalk', title: point.address || 'Точка ' + point.point_no,
      subtitle: 'Точка ' + point.point_no + (point.status ? ', ' + point.status : ''), heading: point.heading, editing });
    if (editing && editor) {
      for (const p of points) if (p !== point) p._marker?.update?.({ draggable: false });
      editor.select({ key: keyOf(point), coordinates: [point.lng, point.lat], heading: point.heading, element: point._element,
        save: ({ coordinates, heading }) => save(point, coordinates ? { longitude: coordinates[0], latitude: coordinates[1] } : { heading }) });
      point._marker?.update?.({ draggable: true });
    }
    const facts = [
      ['Сторона', point.side],
      ['Место', point.role],
      ['Направление кадра', point.heading + '°', 'data-sw-heading'],
      ['Также снимает', point.also_covers],
    ].filter(([, v]) => v != null && v !== '').map(([k, v, attr]) => `<dt>${k}</dt><dd${attr ? ' ' + attr : ''}>${e(v)}</dd>`).join('');
    const tools = editing ? `<section class="pin-section"><h3>Точка</h3>
        <ul class="pin-howto"><li><b>1</b>Перенести — тяните саму точку.</li><li><b>2</b>Повернуть — тяните круглую ручку на конце стрелки.</li><li><b>3</b>Сохраняется само, «Отменить» — внизу экрана.</li></ul>
        <div class="pin-actions"><button type="button" data-sw="delete" class="danger">Удалить точку</button></div>
      </section>` : '';
    const photo = editable ? '<section class="pin-section" data-sw-photo><h3>Фото</h3><p class="pin-note">Загружаем…</p></section>' : '';
    card.innerHTML = `<dl class="pin-facts">${facts}</dl>${photo}${tools}<p class="pin-note" data-sw-status role="status">${e(message || (editable ? '' : 'Правки и фото недоступны: точки показаны из файла.'))}</p>`;
    if (!editable) return;
    renderPhoto(point);
    if (!editing) return;
    card.querySelector('[data-sw="delete"]').addEventListener('click', async () => {
      if (!window.confirm(`Удалить точку ${point.point_no}? Номер больше не будет использован.`)) return;
      setStatus('Удаляем…');
      try {
        await apiRequest(`${API}/${point.id}`, { method: 'DELETE' });
        points = points.filter((p) => p !== point);
        redrawOne(point);
        updateCount();
        current = null;
        editor?.clear();
        popover.close();
      } catch (error) { setStatus('Не удалено: ' + error.message); }
    });
  }

  /** Раздел «Фото»: один снимок на точку, как у площадок ДП/СП. */
  async function renderPhoto(point) {
    const box = card.querySelector('[data-sw-photo]');
    if (!box) return;
    const e = escapeHtml;
    const user = getUser ? getUser() : null;
    const isPrefecture = user?.role === 'prefecture_admin';
    const canUpload = isPrefecture || (user?.role === 'district_editor' && user.district === district);
    let slot;
    try {
      slot = await (await apiRequest(`${API}/${point.id}/slot`)).json();
    } catch (error) {
      box.innerHTML = `<h3>Фото</h3><p class="pin-note bad">Не удалось открыть фото: ${e(error.message)}</p>`;
      return;
    }
    if (current !== point || !box.isConnected) return;
    const state = slot.active ? (slot.active.status === 'accepted' ? 'accepted' : 'pending') : slot.rejected ? 'rework' : 'empty';
    if (point.photo_state !== state) { point.photo_state = state; redrawOne(point); }
    const head = `<h3>Фото <span class="slot-pill ${state}">${PHOTO_LABELS[state]}</span></h3>`;
    if (slot.active) {
      box.innerHTML = `${head}<img class="pin-shot" alt="Снимок тротуара у точки ${e(point.point_no)}" data-sw-shot>
        <p class="pin-note">${state === 'pending' ? 'Загружено' : 'Принято'} ${e(when(slot.active.reviewed_at || slot.active.uploaded_at))}</p>
        ${isPrefecture ? `<div class="pin-actions">${state === 'pending' ? '<button type="button" class="primary" data-sw="accept">Принять фото</button><button type="button" data-sw="return">Вернуть на доработку</button>' : ''}
          <button type="button" class="danger" data-sw="remove">Убрать фото</button></div>` : ''}`;
      try {
        const blob = await (await apiRequest(`${API}/${point.id}/photo`)).blob();
        if (current !== point || !box.isConnected) return;
        if (photoUrl) URL.revokeObjectURL(photoUrl);
        photoUrl = URL.createObjectURL(blob);
        const img = box.querySelector('[data-sw-shot]');
        img.src = photoUrl;
        img.addEventListener('click', () => {
          const viewer = document.getElementById('photoViewer');
          const full = document.getElementById('pvImage');
          if (!viewer || !full) return;
          full.src = photoUrl;
          const name = document.getElementById('pvName');
          if (name) name.textContent = 'Точка ' + point.point_no;
          viewer.showModal();
        });
      } catch (_) { /* превью не обязательно: статус и кнопки уже на месте */ }
      box.querySelector('[data-sw="accept"]')?.addEventListener('click', () => review(point, 'accepted', ''));
      box.querySelector('[data-sw="return"]')?.addEventListener('click', () => askReturn(point, box));
      box.querySelector('[data-sw="remove"]')?.addEventListener('click', async () => {
        if (!window.confirm('Убрать фото с точки? Снимок останется в истории, точка снова будет без фото.')) return;
        try { await apiRequest(`${API}/${point.id}/photo`, { method: 'DELETE' }); renderPhoto(point); }
        catch (error) { setStatus('Фото не убрано: ' + error.message); }
      });
      return;
    }
    const returned = slot.rejected ? `<p class="pin-return"><strong>Вернули на доработку.</strong> ${e(slot.rejected.review_comment)}</p>` : '';
    if (!canUpload) {
      box.innerHTML = `${head}${returned}<p class="pin-note">Фото ещё нет.</p>`;
      return;
    }
    box.innerHTML = `${head}${returned}
      <button type="button" class="pin-drop" data-sw="drop">
        <svg viewBox="0 0 34 34" aria-hidden="true"><path d="M5 11.5h5.2l2.3-3.5h9l2.3 3.5H29v15.5H5z"/><circle cx="17" cy="18.5" r="5.2"/></svg>
        <span><b>${slot.rejected ? 'Загрузить новое фото' : 'Загрузить фото'}</b>
        <small>Снимок вдоль тротуара по стрелке. Можно перетащить файл сюда. JPEG, PNG или WEBP; большое фото уменьшится само.</small></span>
      </button>
      <input type="file" accept="image/jpeg,image/png,image/webp" hidden data-sw="file">`;
    const drop = box.querySelector('[data-sw="drop"]');
    const file = box.querySelector('[data-sw="file"]');
    const send = async (picked) => {
      if (!picked) return;
      drop.disabled = true;
      setStatus('Отправляем фото…');
      try {
        const prepared = await preparePointPhoto(picked);
        await apiRequest(`${API}/${point.id}/photo`, { method: 'PUT', body: prepared,
          headers: { 'Content-Type': prepared.type, 'X-Photo-Filename': encodeURIComponent(prepared.name) } });
        setStatus(isPrefecture ? 'Фото загружено и принято.' : 'Фото отправлено на проверку.');
        renderPhoto(point);
      } catch (error) {
        drop.disabled = false;
        setStatus('Фото не отправлено: ' + error.message);
      }
    };
    drop.addEventListener('click', () => file.click());
    file.addEventListener('change', () => send(file.files[0]));
    drop.addEventListener('dragover', (event) => { event.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (event) => { event.preventDefault(); drop.classList.remove('over'); send(event.dataTransfer.files[0]); });
  }

  function askReturn(point, box) {
    const actions = box.querySelector('.pin-actions');
    actions.innerHTML = '<input data-sw="reason" maxlength="2000" placeholder="Что исправить на снимке" aria-label="Причина возврата"><button type="button" class="primary" data-sw="send-return">Вернуть</button><button type="button" data-sw="cancel">Отмена</button>';
    const reason = actions.querySelector('[data-sw="reason"]');
    reason.focus();
    actions.querySelector('[data-sw="cancel"]').addEventListener('click', () => renderPhoto(point));
    actions.querySelector('[data-sw="send-return"]').addEventListener('click', () => {
      if (!reason.value.trim()) { reason.placeholder = 'Напишите, что исправить'; reason.focus(); return; }
      review(point, 'rejected', reason.value.trim());
    });
  }

  async function review(point, decision, comment) {
    try {
      await apiRequest(`${API}/${point.id}/review`, { method: 'POST', body: JSON.stringify({ decision, comment }) });
      setStatus(decision === 'accepted' ? 'Фото принято.' : 'Фото возвращено на доработку.');
      renderPhoto(point);
    } catch (error) { setStatus('Решение не сохранено: ' + error.message); }
  }

  function updateCount() {
    const count = container.querySelector('.count');
    if (count) count.textContent = points.length.toLocaleString('ru-RU');
    renderList();
  }

  function render(hint) {
    container.innerHTML = '<label class="layer-row' + (isOn ? '' : ' off') + '"><input type="checkbox"' + (isOn ? ' checked' : '') + '><span class="swatch" style="background:#f28c18"></span><span class="label">Тротуары Дворы</span><span class="count">' + points.length.toLocaleString('ru-RU') + '</span></label><div class="shoot-hint">' + escapeHtml(hint) + '</div><details class="shoot-list-box"><summary>Список точек · Тротуары Дворы</summary><div class="shoot-list" data-sidewalk-list></div></details>';
    const check = container.querySelector('input');
    check.addEventListener('change', () => {
      isOn = check.checked;
      check.closest('.layer-row').classList.toggle('off', !isOn);
      if (!isOn) editor?.clear();
      draw();
    });
  }

  async function loadFile() {
    const response = await fetch(`layers/${slug}/sidewalk_shoot.geojson`, { cache: 'no-store' });
    if (!response.ok) return [];
    return ((await response.json()).features || []).map(fromFile);
  }

  function canEditHint() {
    return getUser?.()?.role === 'prefecture_admin'
      ? 'Точка у угла дома со стороны подъездов, стрелка — куда смотрит кадр. Нажмите на точку: её можно перетащить, а стрелку повернуть за ручку.'
      : 'Стрелка показывает направление кадра. Нажмите на точку и загрузите фото тротуара.';
  }

  async function load() {
    // Повторный вход: старые маркеры снимаем до замены списка точек.
    const wasOn = isOn;
    isOn = false;
    draw();
    isOn = wasOn;
    let hint = canEditHint();
    editable = false;
    try {
      const response = await apiRequest(`${API}?district=${encodeURIComponent(district)}`);
      points = ((await response.json()).points || []).map(fromServer);
      editable = points.length > 0;
    } catch (_) { points = []; }
    if (!editable) {
      points = await loadFile().catch(() => []);
      hint = 'Только просмотр: служба фото пока не отдаёт точки тротуаров, показан файл слоя.';
    }
    container.hidden = !visible || !points.length;
    render(hint);
    draw();
  }

  return {
    /** Новая точка из «Разметки» префектуры: сервер выдаёт номер, слой включается и показывает её. */
    async createPoint({ lng, lat, heading }) {
      const response = await apiRequest(API, { method: 'POST', body: JSON.stringify({ district, longitude: lng, latitude: lat, heading }) });
      const created = (await response.json()).point;
      isOn = true;
      await load();
      return created;
    },
    setVisible(on) {
      testLayer.setVisible(on);
      if (on && !visible) isOn = true;
      visible = Boolean(on);
      if (!visible) {
        container.hidden = true;
        isOn = false;
        editor?.clear();
        draw();
        return;
      }
      load();
    },
  };
};


// Независимый закрытый тестовый набор. Маркер указывает место съёмки;
// направление появляется только после выбора одного из кадров в карточке.
function initSidewalkTestLayer({ container, map, card, district, apiRequest, centerSelection, popover, getUser, editor, arrowSvg, preparePointPhoto }) {
  const node = (tag, text, className) => {
    const element = document.createElement(tag);
    if (text) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const keyOf = (point) => 'sidewalk-test:' + point.id;
  const canEdit = () => getUser?.()?.role === 'prefecture_admin';
  const canUpload = () => getUser?.()?.role === 'district_editor' && getUser?.()?.district === district;
  const allowed = () => canEdit() || canUpload();
  const base = '/object-photo-points/sidewalk-test';
  const framePath = slot => base + '/district/frames/' + encodeURIComponent(slot.id);
  const layer = node('div');
  layer.hidden = true;
  layer.id = 'sidewalkTestLayer';
  const checkbox = node('input');
  checkbox.type = 'checkbox';
  const label = node('label', '', 'layer-row off');
  const swatch = node('span', '', 'swatch');
  swatch.style.background = '#176bb0';
  const count = node('span', '—', 'count');
  label.append(checkbox, swatch, node('span', 'Тротуары ОДХ', 'label'), count);
  const hint = node('div', 'Выберите точку и фотослот, чтобы увидеть направление.', 'shoot-hint');
  hint.setAttribute('role', 'status');
  const list = node('details', '', 'shoot-list-box');
  list.hidden = true;
  const search = node('input');
  search.type = 'search';
  search.placeholder = 'ID точки или улица';
  search.setAttribute('aria-label', 'Поиск тестовой точки тротуара');
  const results = node('div', '', 'shoot-list');
  const flagged = node('div', '', 'shoot-list');
  flagged.dataset.noSidewalkGroup = '';
  const flagTitle = node('h4', 'На проверку: нет тротуара');
  const more = node('button', 'Показать ещё');
  more.type = 'button';
  list.append(node('summary', 'Список точек · Тротуары ОДХ'), search, results, flagTitle, flagged, more);
  layer.append(label, hint, list);
  container.after(layer);

  let points = [];
  let markers = new Map();
  let selection = null;
  let request = null;
  let limit = 80;
  let linkedPoint = new URLSearchParams(location.search).get('sidewalkTest');

  function clearSelection() {
    if (!selection) return;
    selection.arrow?.remove();
    if (selection.photoUrl) URL.revokeObjectURL(selection.photoUrl);
    markers.get(selection.point.id)?.marker.update({ draggable: false, zIndex: 40 });
    if (editor?.isSelected(keyOf(selection.point))) editor.clear();
    selection = null;
  }
  popover.onClose(clearSelection);
  new MutationObserver(() => {
    if (selection && !card.contains(selection.content)) clearSelection();
  }).observe(card, { childList: true });

  function bindEditor(point, slot) {
    if (!editor || !canEdit()) return;
    const view = markers.get(point.id);
    const key = keyOf(point);
    let target;
    editor.select({
      key, coordinates: point.coordinates, heading: slot?.azimuth, preciseHeading: true, element: view.element,
      async save({ coordinates, heading }) {
        if (!canEdit()) throw new Error('Доступ к редактированию закрыт.');
        try {
          const change = coordinates ? { coordinates } : { slotId: slot.id, azimuth: heading };
          const response = await apiRequest('/object-photo-points/sidewalk-test/' + encodeURIComponent(point.id), {
            method: 'PATCH', body: JSON.stringify(change),
          });
          const updated = (await response.json()).point;
          const live = markers.get(point.id);
          const item = live?.point || point;
          item.coordinates = updated.coordinates;
          for (const frame of item.slots) frame.azimuth = updated.slots.find(value => value.id === frame.id).azimuth;
          if (coordinates) live?.marker.update({ coordinates: item.coordinates });
          if (selection?.point.id === point.id) {
            if (coordinates) popover.setAnchor(item.coordinates);
            selection.refresh();
            const active = selection.slot;
            if (editor.current() !== target && editor.isSelected(key) && (coordinates || active?.id === slot?.id)) {
              editor.attach(key, live.element, { coordinates: item.coordinates, heading: active?.azimuth });
            }
          }
        } catch (error) {
          if (coordinates) {
            const live = markers.get(point.id);
            live?.marker.update({ coordinates: live.point.coordinates });
          }
          throw error;
        }
      },
    });
    target = editor.current();
    view.marker.update({ draggable: true, zIndex: 45 });
  }

  function paintMark(view) {
    const { element, point } = view;
    element.dataset.noSidewalk = String(Boolean(point.noSidewalk));
    const dot = element.querySelector('.shoot-dot');
    dot.style.background = point.noSidewalk ? '#a83d13' : '#176bb0';
    dot.style.boxShadow = '0 0 0 2px ' + (point.noSidewalk ? '#6a2b14' : '#103a64');
    dot.textContent = point.noSidewalk ? '!' : '';
    element.title = 'Тротуары ОДХ · ' + point.id + ' · ' + point.street + (point.noSidewalk ? ' · Нет тротуара' : '');
    element.setAttribute('aria-label', element.title);
  }

  function openPoint(point) {
    if (!allowed() || !checkbox.checked) return;
    clearSelection();
    editor?.clear();
    centerSelection(point.coordinates);
    popover.open({ coordinates: point.coordinates, kind: 'sidewalk', title: point.street,
      subtitle: 'Тротуары ОДХ · ' + point.id });
    const content = node('section', '', 'pin-section');
    content.append(node('h3', 'Фотослоты · ' + point.slots.length));
    content.append(node('p', 'Задание ' + point.taskId + ' · ' + point.balance, 'pin-note'));
    if (editor && canEdit()) content.append(node('p', 'Перетащите маркер, чтобы перенести точку. Для поворота выберите фотослот и потяните за ручку стрелки. Правки сохраняются автоматически.', 'pin-note'));
    const status = node('p', 'Выберите фотослот для показа стрелки.', 'pin-note');
    status.setAttribute('role', 'status');
    const buttons = node('div', '', 'pin-actions');
    const photoPanel = node('div');
    function showPhoto(slot) {
      if (selection.photoUrl) URL.revokeObjectURL(selection.photoUrl);
      selection.photoUrl = null;
      photoPanel.replaceChildren();
      if (!canUpload()) return;
      const statuses = { empty: 'Нет фото', pending: 'На проверке', accepted: 'Принято', rework: 'На доработке' };
      const info = node('p', statuses[slot.status] || statuses.empty, 'pin-note');
      photoPanel.append(info);
      if (slot.comment) photoPanel.append(node('p', 'Что исправить: ' + slot.comment, 'pin-note'));
      if (slot.photoId) {
        const preview = node('div');
        photoPanel.append(preview);
        apiRequest(framePath(slot) + '/photos/' + encodeURIComponent(slot.photoId))
          .then(response => response.blob()).then(blob => {
            if (!preview.isConnected || selection?.slot !== slot) return;
            selection.photoUrl = URL.createObjectURL(blob);
            const image = node('img');
            image.alt = 'Фото выбранного слота';
            image.style.maxWidth = '100%';
            image.src = selection.photoUrl;
            preview.append(image);
          }).catch(() => { preview.textContent = 'Не удалось открыть фото.'; });
      }
      if (point.noSidewalk || !['empty', 'rework'].includes(slot.status || 'empty')) return;
      const input = node('input');
      input.type = 'file';
      input.accept = 'image/jpeg,image/png,image/webp';
      input.hidden = true;
      const upload = node('button', 'Загрузить фото', 'primary');
      upload.type = 'button';
      upload.addEventListener('click', () => input.click());
      input.addEventListener('change', async () => {
        if (!input.files[0] || !canUpload() || selection?.slot !== slot) return;
        upload.disabled = true;
        info.textContent = 'Отправляем фото…';
        try {
          const file = await preparePointPhoto(input.files[0]);
          if (!canUpload()) return;
          const response = await apiRequest(framePath(slot) + '/photo', {
            method: 'PUT', headers: { 'Content-Type': file.type, 'X-Photo-Filename': encodeURIComponent(file.name) }, body: file,
          });
          const { photo } = await response.json();
          Object.assign(slot, { status: photo.status, photoId: photo.id, comment: '' });
          if (selection?.slot === slot) showPhoto(slot);
        } catch (error) { info.textContent = 'Фото не отправлено: ' + error.message; }
        finally { upload.disabled = false; input.value = ''; }
      });
      photoPanel.append(input, upload);
    }
    const format = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 8 });
    const slotButtons = point.slots.map((slot, index) => {
      const button = node('button', 'Фотослот ' + (index + 1) + ' · ' + format.format(slot.azimuth) + '°');
      button.type = 'button';
      button.setAttribute('aria-pressed', 'false');
      button.addEventListener('click', () => {
        if (selection?.content !== content || !allowed()) return;
        selection.arrow?.remove();
        const arrow = arrowSvg(slot.azimuth, '#176bb0', '#103a64');
        arrow.style.scale = 'max(var(--shoot-arrow-scale,.35),.75)';
        arrow.dataset.slotId = slot.id;
        markers.get(point.id)?.element.append(arrow);
        selection.arrow = arrow;
        selection.slot = slot;
        popover.setHeading(slot.azimuth);
        bindEditor(point, slot);
        for (const other of slotButtons) {
          other.setAttribute('aria-pressed', String(other === button));
          other.classList.toggle('primary', other === button);
        }
        status.textContent = 'Кадр ' + slot.id + ' · направление ' + format.format(slot.azimuth) + '°';
        showPhoto(slot);
      });
      return button;
    });
    buttons.append(...slotButtons);
    const mark = node('button');
    mark.type = 'button';
    const markStatus = node('p', '', 'pin-note');
    markStatus.setAttribute('role', 'status');
    const updateMark = () => {
      mark.textContent = point.noSidewalk ? 'Снять пометку «Нет тротуара»' : 'Нет тротуара';
      markStatus.textContent = point.noSidewalk ? 'Помечено: нет тротуара · на проверку' : '';
    };
    updateMark();
    mark.addEventListener('click', async () => {
      if (!allowed() || mark.disabled) return;
      mark.disabled = true;
      try {
        const response = await apiRequest('/object-photo-points/sidewalk-test/' + encodeURIComponent(point.id), {
          method: 'PATCH', body: JSON.stringify({ noSidewalk: !point.noSidewalk }),
        });
        const { point: saved } = await response.json();
        const live = markers.get(point.id);
        if (live?.point !== point) return;
        point.noSidewalk = saved.noSidewalk === true;
        paintMark(live);
        updateMark();
        if (selection?.point === point && selection.slot) showPhoto(selection.slot);
        renderList();
      } catch (error) { markStatus.textContent = 'Пометка не сохранена: ' + error.message; }
      finally { mark.disabled = false; }
    });
    const markActions = node('div', '', 'pin-actions');
    markActions.append(mark);
    content.append(buttons, status, photoPanel, markActions, markStatus);
    selection = { point, content, arrow: null, slot: null, refresh() {
      point.slots.forEach((slot, index) => {
        slotButtons[index].textContent = 'Фотослот ' + (index + 1) + ' · ' + format.format(slot.azimuth) + '°';
      });
      if (this.slot) status.textContent = 'Кадр ' + this.slot.id + ' · направление ' + format.format(this.slot.azimuth) + '°';
    } };
    card.replaceChildren(content);
    bindEditor(point);
  }

  function draw() {
    const next = new Map();
    for (const point of points) {
      const element = node('button', '', 'shoot-marker');
      element.type = 'button';
      const dot = node('span', '', 'shoot-dot');
      dot.style.cssText = 'left:-8px;top:-8px;width:16px;height:16px;border-color:#fff;color:white;font:bold 11px/12px sans-serif;text-align:center';
      element.append(dot);
      const key = keyOf(point);
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        if (!editor?.takeSuppressedClick(key)) openPoint(point);
      });
      const marker = new window.ymaps3.YMapMarker({ coordinates: point.coordinates, zIndex: 40,
        ...(editor && canEdit() ? editor.dragHandlers(key) : {}) }, element);
      map.addChild(marker);
      const view = { marker, element, point };
      next.set(point.id, view);
      paintMark(view);
    }
    markers = next;
  }

  function renderList() {
    const query = search.value.trim().toLocaleLowerCase('ru');
    const matched = points.filter(point => (point.id + ' ' + point.street + ' ' + point.taskId).toLocaleLowerCase('ru').includes(query));
    const makeRow = (point) => {
      const row = node('button', '', 'shoot-item');
      row.type = 'button';
      row.style.cssText = 'width:100%;text-align:left;background:white';
      row.append(node('b', point.id), node('span', point.street + (point.district !== district ? ' · ' + point.district : '')));
      row.addEventListener('click', () => openPoint(point));
      return row;
    };
    const regular = matched.filter(point => !point.noSidewalk);
    const review = matched.filter(point => point.noSidewalk);
    results.replaceChildren(...regular.slice(0, limit).map(makeRow));
    if (!regular.length) results.textContent = 'Нет обычных точек по запросу.';
    flagTitle.textContent = 'На проверку: нет тротуара · ' + review.length.toLocaleString('ru-RU');
    flagged.replaceChildren(...review.slice(0, limit).map(makeRow));
    more.hidden = Math.max(regular.length, review.length) <= limit;
  }

  function stop() {
    request?.abort();
    request = null;
    if (selection && card.contains(selection.content)) popover.close();
    clearSelection();
    for (const { marker } of markers.values()) map.removeChild(marker);
    markers.clear();
    list.hidden = true;
    results.replaceChildren();
    flagged.replaceChildren();
  }

  checkbox.addEventListener('change', async () => {
    label.classList.toggle('off', !checkbox.checked);
    stop();
    if (!checkbox.checked || !allowed()) return;
    const controller = new AbortController();
    request = controller;
    hint.textContent = 'Загружаем точки ОДХ…';
    try {
      const response = await apiRequest(base + (canEdit() ? '?district=' + encodeURIComponent(district) : '/district'), { signal: controller.signal });
      const payload = await response.json();
      if (request !== controller || !allowed() || !checkbox.checked) return;
      points = payload.points;
      count.textContent = points.length.toLocaleString('ru-RU');
      hint.textContent = points.reduce((total, point) => total + point.slots.length, 0).toLocaleString('ru-RU')
        + ' фотослотов. Стрелка появится после выбора кадра.';
      search.value = '';
      limit = 80;
      list.hidden = false;
      renderList();
      draw();
      if (linkedPoint) {
        const point = markers.get(linkedPoint)?.point;
        linkedPoint = null;
        if (point) openPoint(point);
      }
    } catch (error) {
      if (request !== controller) return;
      hint.textContent = 'Слой ОДХ не загружен: ' + error.message;
      checkbox.checked = false;
      label.classList.add('off');
    } finally {
      if (request === controller) request = null;
    }
  });
  search.addEventListener('input', () => { limit = 80; renderList(); });
  more.addEventListener('click', () => { limit += 80; renderList(); });

  return {
    setVisible(visible) {
      layer.hidden = !visible || !allowed();
      if (!layer.hidden && linkedPoint && !checkbox.checked) {
        checkbox.checked = true;
        checkbox.dispatchEvent(new Event('change'));
      }
      if (layer.hidden) {
        stop();
        checkbox.checked = false;
        label.classList.add('off');
        points = [];
        count.textContent = '—';
        hint.textContent = 'Выберите точку и фотослот, чтобы увидеть направление.';
      }
    },
  };
}
