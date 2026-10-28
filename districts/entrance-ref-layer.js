// Входные группы (подъезды МКД) — ориентир для расстановки точек съёмки
// тротуаров. Данные: districts/layers/<район>/entrances.geojson из реестра
// подъездов (projects/sidewalk-photo-points/work/build_entrance_layers.py).
// Строку видит только префектура: страница вызывает setVisible при входе и выходе.
window.initEntranceRefLayer = function ({ map, slug, escapeHtml, centerSelection, popover }) {
  const container = document.getElementById('entranceRefLayer');
  const card = document.getElementById('card');
  let features = [];
  let markers = [];
  let visible = false;
  let isOn = false;
  let loaded = null;

  function marker(feature) {
    const p = feature.properties;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'entrance-ref';
    el.textContent = p.entrance;
    el.title = `${p.address}, подъезд ${p.entrance}`;
    el.setAttribute('aria-label', el.title);
    el.addEventListener('click', (event) => {
      event.stopPropagation();
      centerSelection(feature.geometry.coordinates);
      popover.open({ coordinates: feature.geometry.coordinates, kind: 'door', title: p.address, subtitle: `Подъезд ${p.entrance}` });
      const e = escapeHtml;
      const facts = [
        ['Этажность', p.floors],
        ['Лифтов в подъезде', p.lifts],
        ['Мусорокамера', p.garbage_chute],
        ['Участок', p.plot],
        ['УНОМ', p.unom],
      ].filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${k}</dt><dd>${e(v)}</dd>`).join('');
      card.innerHTML = `<dl class="pin-facts">${facts}</dl><p class="pin-note">Ориентир для точек съёмки тротуаров: снимайте тротуар со стороны подъездов.</p>`;
    });
    return new window.ymaps3.YMapMarker({ coordinates: feature.geometry.coordinates }, el);
  }

  function show() {
    for (const m of markers) { try { map.removeChild(m); } catch (_) { /* уже снят */ } }
    markers = isOn && visible ? features.map(marker) : [];
    for (const m of markers) map.addChild(m);
  }

  function load() {
    loaded = loaded || fetch(`layers/${slug}/entrances.geojson`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { features = (data && data.features) || []; })
      .catch(() => { features = []; });
    return loaded;
  }

  async function render() {
    await load();
    container.hidden = !visible || !features.length;
    if (container.hidden) return;
    container.innerHTML = '<label class="layer-row' + (isOn ? '' : ' off') + '"><input type="checkbox"' + (isOn ? ' checked' : '') + '><span class="swatch" style="background:#1d3c4f"></span><span class="label">Входные группы (подъезды)</span><span class="count">' + features.length.toLocaleString('ru-RU') + '</span></label><div class="shoot-hint">Ориентир для точек тротуаров: метка с номером подъезда.</div>';
    const check = container.querySelector('input');
    check.addEventListener('change', () => {
      isOn = check.checked;
      check.closest('.layer-row').classList.toggle('off', !isOn);
      show();
    });
  }

  return {
    setVisible(on) {
      visible = Boolean(on);
      if (!visible) { isOn = false; container.hidden = true; show(); return; }
      render();
    },
  };
};
