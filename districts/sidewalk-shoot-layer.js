// Точки съёмки тротуаров у МКД: черновая расстановка из
// projects/sidewalk-photo-points/work/build_sidewalk_photo_points.py.
// Слой статический: файла у района нет — строка в панели не показывается.
// Пока это тест, строку видит только префектура: страница вызывает setVisible
// при каждом входе и выходе.
window.initSidewalkShootLayer = function ({ map, slug, escapeHtml, centerSelection }) {
  const container = document.getElementById('sidewalkShootLayer');
  const card = document.getElementById('card');
  let features = [];
  let markers = [];
  let visible = false;

  function marker(feature) {
    const p = feature.properties || {};
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'shoot-marker sidewalk-shoot';
    el.title = `Тротуар ${p.point_no} · ${p.address} · ${p.azimuth}°`;
    el.innerHTML = '<span class="shoot-dot"></span>';
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('class', 'shoot-arrow');
    arrow.setAttribute('viewBox', '0 0 64 80');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.style.transform = 'rotate(' + Number(p.azimuth) + 'deg)';
    arrow.innerHTML = '<path d="M32 4 L14 26 L25 26 L25 70 L39 70 L39 26 L50 26 Z" fill="none" stroke="white" stroke-width="8" stroke-linejoin="round"/><path d="M32 4 L14 26 L25 26 L25 70 L39 70 L39 26 L50 26 Z" fill="#7b4fc9" stroke="#2c1563" stroke-width="3" stroke-linejoin="round"/>';
    el.append(arrow);
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      centerSelection(feature.geometry.coordinates);
      const e = escapeHtml;
      const rows = [
        ['Адрес', p.address],
        ['Сторона', p.side],
        ['Место', p.role],
        ['Направление кадра', p.azimuth + '°'],
        ['Также снимает', p.also_covers],
        ['Статус', p.status],
      ].filter(([, v]) => v != null && v !== '').map(([k, v]) => `<div><strong>${k}:</strong> ${e(v)}</div>`).join('');
      card.innerHTML = `<h2>Точка съёмки тротуара ${e(p.point_no)}</h2>${rows}`;
      card.className = 'card open';
    });
    return new window.ymaps3.YMapMarker({ coordinates: feature.geometry.coordinates }, el);
  }

  function show(on) {
    for (const m of markers) { try { map.removeChild(m); } catch (_) { /* уже снят */ } }
    markers = on ? features.map(marker) : [];
    for (const m of markers) map.addChild(m);
  }

  fetch(`layers/${slug}/sidewalk_shoot.geojson`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      features = (data && data.features) || [];
      if (!features.length) return;
      container.hidden = !visible;
      container.innerHTML = '<label class="layer-row off"><input type="checkbox"><span class="swatch" style="background:#7b4fc9"></span><span class="label">Точки съёмки · тротуары (тест)</span><span class="count">' + features.length.toLocaleString('ru-RU') + '</span></label><div class="shoot-hint">Черновик: точки у углов домов со стороны подъездов, стрелка — куда смотрит кадр.</div>';
      const check = container.querySelector('input');
      check.addEventListener('change', () => {
        check.closest('.layer-row').classList.toggle('off', !check.checked);
        show(check.checked);
      });
    })
    .catch(() => { /* слоя нет — строку не показываем */ });

  return {
    setVisible(on) {
      visible = Boolean(on);
      container.hidden = !visible;
      if (visible) return;
      const check = container.querySelector('input');
      if (check && check.checked) {
        check.checked = false;
        check.closest('.layer-row').classList.add('off');
      }
      show(false);
    },
  };
};
