// Точки съёмки тротуаров у МКД: черновая расстановка из
// projects/sidewalk-photo-points/work/build_sidewalk_photo_points.py.
// Пока это тест, строку видит только префектура: страница вызывает setVisible
// при каждом входе и выходе. Точки берутся со службы фото, где префектура их
// переносит, поворачивает и удаляет. Если служба недоступна или точки туда ещё
// не загружены, показывается опубликованный файл слоя — без правок.
window.initSidewalkShootLayer = function ({ map, slug, district, apiRequest, escapeHtml, centerSelection }) {
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
    also_covers: p.also_covers, status: p.status, heading: Number(p.heading), lng: Number(p.longitude), lat: Number(p.latitude) });
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
      Object.assign(point, fromServer((await response.json()).point));
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
    const rows = [
      ['Адрес', point.address],
      ['Сторона', point.side],
      ['Место', point.role],
      ['Направление кадра', point.heading + '°'],
      ['Также снимает', point.also_covers],
      ['Статус', point.status],
    ].filter(([, v]) => v != null && v !== '').map(([k, v]) => `<div><strong>${k}:</strong> ${e(v)}</div>`).join('');
    const tools = editable ? `<div class="sw-tools">
        <div class="row"><button type="button" data-sw="left" title="Повернуть против часовой">⟲ ${STEP}°</button>
        <input type="number" min="0" max="359" step="1" value="${point.heading}" data-sw="heading" aria-label="Направление кадра, градусы">
        <button type="button" data-sw="right" title="Повернуть по часовой">${STEP}° ⟳</button>
        <button type="button" data-sw="save-heading" class="primary">Сохранить направление</button></div>
        <div class="row"><button type="button" data-sw="move">${movingId === point.id ? 'Отменить перенос' : 'Перенести'}</button>
        <button type="button" data-sw="delete" class="danger">Удалить точку</button></div>
      </div>` : '';
    card.innerHTML = `<h2>Точка съёмки тротуара ${e(point.point_no)}</h2>${rows}${tools}<div class="status" data-sw-status role="status">${e(message || (editable ? '' : 'Правки недоступны: точки показаны из файла.'))}</div>`;
    card.className = 'card open';
    if (!editable) return;
    const input = card.querySelector('[data-sw="heading"]');
    const preview = (deg) => {
      const heading = ((Math.round(deg) % 360) + 360) % 360;
      input.value = heading;
      if (point._arrow) point._arrow.style.transform = 'rotate(' + heading + 'deg)';
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
      openCard(point, movingId ? 'Перетащите точку на новое место — она сохранится сама.' : '');
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
        card.innerHTML = `<h2>Точка ${e(point.point_no)} удалена</h2>`;
      } catch (error) { setStatus('Не удалено: ' + error.message); }
    });
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
