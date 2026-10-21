(function () {
  'use strict';
  const arrow = '<svg viewBox="0 0 72 96" aria-hidden="true"><path d="M36 8 L13 39 L27 39 L27 88 L45 88 L45 39 L59 39 Z" fill="none" stroke="white" stroke-width="10" stroke-linejoin="round"/><path d="M36 8 L13 39 L27 39 L27 88 L45 88 L45 39 L59 39 Z" fill="#ffcf1c" stroke="#16345b" stroke-width="4" stroke-linejoin="round"/><circle cx="36" cy="88" r="5" fill="#16345b" stroke="white" stroke-width="2"/></svg>';
  async function load(url) {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return response.json();
  }
  function showCard(card, feature) {
    const p = feature.properties;
    card.replaceChildren();
    const title = document.createElement('h2'); title.textContent = 'Направление съёмки №' + p.fid;
    card.append(title);
    for (const text of [p.district, 'Азимут: ' + p.azimuth + '°', 'Координаты: ' + feature.geometry.coordinates[1].toFixed(6) + ', ' + feature.geometry.coordinates[0].toFixed(6), 'Источник: Ракурсы_180.geojson']) {
      const line = document.createElement('div'); line.textContent = text; card.append(line);
    }
    card.className = 'card open';
  }
  window.SaoDistrictDirections = {
    async mount({ map, slug, controls, card }) {
      try {
        const manifest = await load('directions/manifest.json');
        const district = manifest.districts[slug];
        if (!district) return;
        const data = await load('directions/' + district.file);
        const elements = [];
        const markers = data.features.map(feature => {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'direction-marker';
          button.title = 'Направление №' + feature.properties.fid + ' · ' + feature.properties.azimuth + '°';
          button.setAttribute('aria-label', button.title);
          button.dataset.fid = feature.properties.fid;
          button.dataset.azimuth = feature.properties.azimuth;
          button.innerHTML = arrow;
          elements.push(button);
          button.addEventListener('click', event => { event.stopPropagation(); showCard(card, feature); });
          return new window.ymaps3.YMapMarker({ coordinates: feature.geometry.coordinates, zIndex: 2400 }, button);
        });
        let currentScale;
        const resize = zoom => {
          const scale = Math.round(Math.min(1, Math.max(0.18, 2 ** ((zoom - 18) / 2))) * 1000) / 1000;
          if (scale === currentScale) return;
          currentScale = scale;
          for (const button of elements) button.firstChild.style.transform = 'rotate(' + button.dataset.azimuth + 'deg) scale(' + scale + ')';
        };
        resize(map.zoom);
        map.addChild(new window.ymaps3.YMapListener({ onUpdate: ({ location }) => resize(location.zoom) }));
        let visible = false;
        const toggle = on => {
          if (on === visible) return;
          for (const marker of markers) { if (on) map.addChild(marker); else map.removeChild(marker); }
          visible = on;
        };
        const row = document.createElement('label'); row.className = 'layer-row'; row.id = 'directionLayerRow';
        row.innerHTML = '<input type="checkbox" id="directionLayerToggle" checked><span class="swatch" style="background:#ffcf1c;border:2px solid #16345b"></span><span class="label">Направления съёмки · Ракурсы 180</span><span class="count"></span>';
        row.querySelector('.count').textContent = String(markers.length);
        row.querySelector('input').addEventListener('change', event => { toggle(event.target.checked); row.classList.toggle('off', !event.target.checked); });
        controls.append(row);
        toggle(true);
      } catch (error) {
        const note = document.createElement('p'); note.className = 'direction-layer-note';
        note.textContent = 'Слой направлений съёмки не загрузился: ' + error.message;
        controls.append(note);
      }
    }
  };
}());
