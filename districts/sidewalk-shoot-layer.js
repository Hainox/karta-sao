// Точки съёмки тротуаров у МКД: черновая расстановка из
// projects/sidewalk-photo-points/work/build_sidewalk_photo_points.py.
// Пока это тест, строку видит только префектура: страница вызывает setVisible
// при каждом входе и выходе. Точки берутся со службы фото, где префектура их
// переносит, поворачивает и удаляет. Если служба недоступна или точки туда ещё
// не загружены, показывается опубликованный файл слоя — без правок.
window.initSidewalkShootLayer = function ({ map, slug, district, apiRequest, escapeHtml, centerSelection, popover, getUser, preparePointPhoto }) {
  const container = document.getElementById('sidewalkShootLayer');
  const card = document.getElementById('card');
  const API = '/object-photo-points/sidewalks';
  const STEP = 15;
  let points = [];
  let editable = false;
  let visible = false;
  let isOn = false;
  let current = null;
  let movingId = null;
  let suppressClick = false;

  const fromServer = (p) => ({ id: p.id, point_no: p.point_no, address: p.address, side: p.side, role: p.role,
    also_covers: p.also_covers, status: p.status, heading: Number(p.heading), lng: Number(p.longitude), lat: Number(p.latitude),
    photo_state: p.photo_state || 'empty' });
  const PHOTO_LABELS = { empty: 'Нет фото', pending: 'На проверке', accepted: 'Принято', rework: 'На доработке' };
  const when = (value) => value ? new Date(value).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  let photoUrl = null;
  const fromFile = (f) => ({ id: f.properties.point_no, point_no: f.properties.point_no, address: f.properties.address,
    side: f.properties.side, role: f.properties.role, also_covers: f.properties.also_covers, status: f.properties.status,
    heading: Number(f.properties.azimuth), lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] });

  function arrowSvg(heading) {
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'shoot-arrow');
    arrow.setAttribute('viewBox', '0 0 64 80');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.style.transform = 'rotate(' + heading + 'deg)';
    arrow.innerHTML = '<path d="M32 4 L14 26 L25 26 L25 70 L39 70 L39 26 L50 26 Z" fill="none" stroke="white" stroke-width="8" stroke-linejoin="round"/><path d="M32 4 L14 26 L25 26 L25 70 L39 70 L39 26 L50 26 Z" fill="#7b4fc9" stroke="#2c1563" stroke-width="3" stroke-linejoin="round"/>';
    return arrow;
  }

  function markerFor(point) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'shoot-marker sidewalk-shoot' + (point.id === movingId ? ' moving' : '');
    if (point.photo_state && point.photo_state !== 'empty') el.dataset.photoState = point.photo_state;
    el.title = `Тротуар ${point.point_no} · ${point.address} · ${point.heading}°`;
    el.innerHTML = '<span class="shoot-dot"></span>';
    el.append(arrowSvg(point.heading));
    point._arrow = el.lastChild;
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      if (suppressClick) { suppressClick = false; return; }
      centerSelection([point.lng, point.lat]);
      openCard(point);
    });
    return new window.ymaps3.YMapMarker({
      coordinates: [point.lng, point.lat],
      draggable: point.id === movingId,
      mapFollowsOnDrag: false,
      onDragEnd: (coordinates) => { suppressClick = true; commitMove(point, coordinates); },
    }, el);
  }

  function draw() {
    for (const p of points) { if (p._marker) { try { map.removeChild(p._marker); } catch (_) { /* уже снят */ } p._marker = null; } }
    if (!isOn || !visible) return;
    for (const p of points) { p._marker = markerFor(p); map.addChild(p._marker); }
  }

  function redrawOne(point) {
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

  async function save(point, body, okText) {
    setStatus('Сохраняем…');
    try {
      const response = await apiRequest(`${API}/${point.id}`, { method: 'PATCH', body: JSON.stringify(body) });
      const photoState = point.photo_state;
      Object.assign(point, fromServer((await response.json()).point), { photo_state: photoState });
      redrawOne(point);
      if (current === point) openCard(point, okText);
      return true;
    } catch (error) {
      setStatus('Не сохранено: ' + error.message);
      return false;
    }
  }

  async function commitMove(point, coordinates) {
    const [lng, lat] = coordinates;
    movingId = null;
    const ok = await save(point, { longitude: lng, latitude: lat }, 'Точка перенесена.');
    if (!ok) redrawOne(point);
  }

  function openCard(point, message = '') {
    current = point;
    const e = escapeHtml;
    popover.open({ coordinates: [point.lng, point.lat], kind: 'sidewalk', title: point.address || 'Точка ' + point.point_no,
      subtitle: 'Точка ' + point.point_no + (point.status ? ', ' + point.status : ''), heading: point.heading });
    const facts = [
      ['Сторона', point.side],
      ['Место', point.role],
      ['Направление кадра', point.heading + '°'],
      ['Также снимает', point.also_covers],
    ].filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${k}</dt><dd>${e(v)}</dd>`).join('');
    const tools = editable ? `<section class="pin-section"><h3>Точка</h3>
        <div class="pin-actions"><button type="button" data-sw="left" aria-label="Повернуть на ${STEP}° против часовой">⟲ ${STEP}°</button>
        <input type="number" min="0" max="359" step="1" value="${point.heading}" data-sw="heading" aria-label="Направление кадра, градусы" style="flex:0 0 70px">
        <button type="button" data-sw="right" aria-label="Повернуть на ${STEP}° по часовой">${STEP}° ⟳</button>
        <button type="button" data-sw="save-heading" class="primary">Сохранить направление</button></div>
        <div class="pin-actions"><button type="button" data-sw="move">${movingId === point.id ? 'Отменить перенос' : 'Перенести'}</button>
        <button type="button" data-sw="delete" class="danger">Удалить точку</button></div>
      </section>` : '';
    const photo = editable ? '<section class="pin-section" data-sw-photo><h3>Фото</h3><p class="pin-note">Загружаем…</p></section>' : '';
    card.innerHTML = `<dl class="pin-facts">${facts}</dl>${photo}${tools}<p class="pin-note" data-sw-status role="status">${e(message || (editable ? '' : 'Правки и фото недоступны: точки показаны из файла.'))}</p>`;
    if (!editable) return;
    renderPhoto(point);
    const input = card.querySelector('[data-sw="heading"]');
    const preview = (deg) => {
      const heading = ((Math.round(deg) % 360) + 360) % 360;
      input.value = heading;
      if (point._arrow) point._arrow.style.transform = 'rotate(' + heading + 'deg)';
      popover.setHeading(heading);
    };
    card.querySelector('[data-sw="left"]').addEventListener('click', () => preview(Number(input.value) - STEP));
    card.querySelector('[data-sw="right"]').addEventListener('click', () => preview(Number(input.value) + STEP));
    input.addEventListener('input', () => { if (input.value !== '') preview(Number(input.value)); });
    card.querySelector('[data-sw="save-heading"]').addEventListener('click', () => {
      const heading = Number(input.value);
      if (!Number.isFinite(heading)) { setStatus('Введите направление от 0 до 359.'); return; }
      save(point, { heading: ((Math.round(heading) % 360) + 360) % 360 }, 'Направление сохранено.');
    });
    card.querySelector('[data-sw="move"]').addEventListener('click', () => {
      movingId = movingId === point.id ? null : point.id;
      redrawOne(point);
      openCard(point, movingId ? 'Перетащите точку на новое место: она сохранится сама.' : '');
    });
    card.querySelector('[data-sw="delete"]').addEventListener('click', async () => {
      if (!window.confirm(`Удалить точку ${point.point_no}? Номер больше не будет использован.`)) return;
      setStatus('Удаляем…');
      try {
        await apiRequest(`${API}/${point.id}`, { method: 'DELETE' });
        points = points.filter((p) => p !== point);
        redrawOne(point);
        updateCount();
        current = null;
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
  }

  function render(hint) {
    container.innerHTML = '<label class="layer-row' + (isOn ? '' : ' off') + '"><input type="checkbox"' + (isOn ? ' checked' : '') + '><span class="swatch" style="background:#7b4fc9"></span><span class="label">Точки съёмки · тротуары (тест)</span><span class="count">' + points.length.toLocaleString('ru-RU') + '</span></label><div class="shoot-hint">' + escapeHtml(hint) + '</div>';
    const check = container.querySelector('input');
    check.addEventListener('change', () => {
      isOn = check.checked;
      check.closest('.layer-row').classList.toggle('off', !isOn);
      if (!isOn) movingId = null;
      draw();
    });
  }

  async function loadFile() {
    const response = await fetch(`layers/${slug}/sidewalk_shoot.geojson`, { cache: 'no-store' });
    if (!response.ok) return [];
    return ((await response.json()).features || []).map(fromFile);
  }

  async function load() {
    // Повторный вход: старые маркеры снимаем до замены списка точек.
    const wasOn = isOn;
    isOn = false;
    draw();
    isOn = wasOn;
    let hint = 'Точка у угла дома со стороны подъездов, стрелка — куда смотрит кадр. Откройте точку, чтобы перенести, повернуть или удалить её.';
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
      visible = Boolean(on);
      if (!visible) {
        container.hidden = true;
        isOn = false;
        movingId = null;
        draw();
        return;
      }
      load();
    },
  };
};
