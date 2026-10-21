(function () {
  'use strict';
  const arrow = '<svg viewBox="0 0 72 96" aria-hidden="true"><path d="M36 8 L13 39 L27 39 L27 88 L45 88 L45 39 L59 39 Z" fill="none" stroke="white" stroke-width="10" stroke-linejoin="round"/><path d="M36 8 L13 39 L27 39 L27 88 L45 88 L45 39 L59 39 Z" fill="#ffcf1c" stroke="#16345b" stroke-width="4" stroke-linejoin="round"/></svg><span class="direction-anchor" aria-hidden="true"></span>';
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
    async mount({ map, slug, controls, card, request, getUser, onEditingChange }) {
      try {
        const manifest = await load('directions/manifest.json');
        const district = manifest.districts[slug];
        if (!district) return;
        const data = await load('directions/' + district.file);
        const endpoint = '/object-photo-points/directions';
        let editing = false, busy = false, serverReady = false, turning = null, currentScale = 0.25;
        const entries = [];
        const editor = document.createElement('div'); editor.className = 'direction-editor';
        const edit = document.createElement('button'); edit.type = 'button'; edit.id = 'directionEditToggle';
        const status = document.createElement('p'); status.id = 'directionEditStatus'; status.setAttribute('aria-live', 'polite');
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Загрузить корректировки'; retry.hidden = true;
        editor.append(edit, retry, status);
        const isPrefecture = () => getUser()?.role === 'prefecture_admin';
        const applyPosition = (entry, coordinates) => {
          entry.feature.geometry.coordinates = [...coordinates];
          entry.button.dataset.coordinates = JSON.stringify(coordinates);
          entry.marker.update({ coordinates: [...coordinates] });
        };
        const applyHeading = (entry, azimuth) => {
          entry.feature.properties.azimuth = azimuth;
          entry.button.dataset.azimuth = azimuth;
          entry.button.title = 'Направление №' + entry.feature.properties.fid + ' · ' + azimuth + '°';
          entry.button.setAttribute('aria-label', entry.button.title);
          entry.button.firstChild.style.transform = 'rotate(' + azimuth + 'deg) scale(' + currentScale + ')';
        };
        function openCard(entry) {
          showCard(card, entry.feature);
          if (!editing || !isPrefecture()) return;
          const actions = document.createElement('div'); actions.className = 'direction-card-actions';
          const label = document.createElement('label'); label.textContent = 'Азимут, ° ';
          const angle = document.createElement('input'); angle.type = 'number'; angle.min = '0'; angle.max = '359.99999'; angle.step = 'any'; angle.required = true; angle.value = entry.feature.properties.azimuth;
          label.append(angle);
          const submit = document.createElement('button'); submit.type = 'button'; submit.textContent = 'Сохранить азимут';
          submit.addEventListener('click', () => { if (angle.reportValidity()) save(entry, entry.saved, Number(angle.value)); });
          const picker = document.createElement('button'); picker.type = 'button'; picker.textContent = 'Указать направление на карте';
          picker.addEventListener('click', () => { turning = entry; status.textContent = 'Нажмите на карте в ту сторону, куда должна смотреть стрелка №' + entry.feature.properties.fid + '. Escape — отмена.'; });
          actions.append(label, submit, picker); card.append(actions);
        }
        function refreshUser() {
          if (!isPrefecture()) { editing = false; turning = null; }
          edit.hidden = !isPrefecture();
          edit.disabled = busy || !serverReady;
          edit.textContent = editing ? 'Завершить корректировку' : 'Корректировать стрелки';
          edit.setAttribute('aria-pressed', String(editing));
          for (const entry of entries) {
            entry.marker.update({ draggable: editing && !busy });
            entry.button.classList.toggle('editing', editing);
          }
        }
        async function reload() {
          const response = await request(endpoint + '/public?district=' + encodeURIComponent(district.district));
          const { corrections } = await response.json();
          const byId = new Map(corrections.map(row => [row.fid, row]));
          for (const entry of entries) {
            const row = byId.get(entry.feature.properties.fid);
            entry.saved = row ? [row.longitude, row.latitude] : [...entry.original];
            entry.version = row?.version ?? 0;
            entry.savedAzimuth = row?.azimuth ?? entry.originalAzimuth;
            applyHeading(entry, entry.savedAzimuth);
            applyPosition(entry, entry.saved);
          }
          serverReady = true; retry.hidden = true;
        }
        async function save(entry, coordinates, azimuth = entry.feature.properties.azimuth) {
          if (!editing || busy || !isPrefecture()) { applyPosition(entry, entry.saved); return; }
          busy = true; turning = null; refreshUser();
          applyPosition(entry, coordinates);
          status.textContent = 'Сохраняем положение стрелки №' + entry.feature.properties.fid + '…';
          try {
            const response = await request(endpoint + '/' + entry.feature.properties.fid, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ longitude: coordinates[0], latitude: coordinates[1], azimuth, expectedVersion: entry.version }) });
            const { correction } = await response.json();
            entry.saved = [correction.longitude, correction.latitude]; entry.version = correction.version;
            entry.savedAzimuth = correction.azimuth; applyHeading(entry, correction.azimuth);
            applyPosition(entry, entry.saved);
            status.textContent = 'Положение стрелки №' + entry.feature.properties.fid + ' сохранено.';
            openCard(entry);
          } catch (error) {
            applyPosition(entry, entry.saved); applyHeading(entry, entry.savedAzimuth);
            try { await reload(); } catch (_) { serverReady = false; retry.hidden = false; }
            status.textContent = 'Корректировка не сохранена: ' + error.message;
          } finally { busy = false; refreshUser(); }
        }
        for (const feature of data.features) {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'direction-marker';
          button.title = 'Направление №' + feature.properties.fid + ' · ' + feature.properties.azimuth + '°';
          button.setAttribute('aria-label', button.title);
          button.dataset.fid = feature.properties.fid; button.dataset.azimuth = feature.properties.azimuth;
          button.dataset.coordinates = JSON.stringify(feature.geometry.coordinates);
          button.innerHTML = arrow;
          const entry = { feature, button, original: [...feature.geometry.coordinates], saved: [...feature.geometry.coordinates], version: 0, originalAzimuth: feature.properties.azimuth, savedAzimuth: feature.properties.azimuth };
          entry.marker = new window.ymaps3.YMapMarker({ coordinates: [...entry.saved], zIndex: 2400, draggable: false, mapFollowsOnDrag: false,
            onDragMove: coordinates => { entry.feature.geometry.coordinates = [...coordinates]; button.dataset.coordinates = JSON.stringify(coordinates); },
            onDragEnd: coordinates => save(entry, coordinates) }, button);
          button.addEventListener('click', event => { event.stopPropagation(); if (!busy) openCard(entry); });
          entries.push(entry);
        }
        const resize = zoom => {
          const scale = Math.round(Math.min(1, Math.max(0.18, 2 ** ((zoom - 18) / 2))) * 1000) / 1000;
          if (scale === currentScale) return;
          currentScale = scale;
          for (const entry of entries) entry.button.firstChild.style.transform = 'rotate(' + entry.button.dataset.azimuth + 'deg) scale(' + scale + ')';
        };
        resize(map.zoom);
        map.addChild(new window.ymaps3.YMapListener({ layer: 'any', onUpdate: ({ location }) => resize(location.zoom), onClick: (_object, event) => {
          if (!turning || !editing || busy || !event?.coordinates) return;
          const entry = turning;
          const [lng, lat] = entry.saved, [targetLng, targetLat] = event.coordinates;
          if (Math.abs(lng - targetLng) + Math.abs(lat - targetLat) < 1e-10) return;
          const rad = Math.PI / 180, delta = (targetLng - lng) * rad;
          const heading = (Math.atan2(Math.sin(delta) * Math.cos(targetLat * rad), Math.cos(lat * rad) * Math.sin(targetLat * rad) - Math.sin(lat * rad) * Math.cos(targetLat * rad) * Math.cos(delta)) / rad + 360) % 360;
          save(entry, entry.saved, Math.round(heading * 100000) / 100000 % 360);
        } }));
        document.addEventListener('keydown', event => { if (event.key === 'Escape' && turning) { turning = null; status.textContent = 'Изменение направления отменено.'; } });
        let visible = false;
        const toggle = on => {
          if (on === visible) return;
          for (const entry of entries) { if (on) map.addChild(entry.marker); else map.removeChild(entry.marker); }
          visible = on;
        };
        const row = document.createElement('label'); row.className = 'layer-row'; row.id = 'directionLayerRow';
        row.innerHTML = '<input type="checkbox" id="directionLayerToggle" checked><span class="swatch" style="background:#ffcf1c;border:2px solid #16345b"></span><span class="label">Направления съёмки · Ракурсы 180</span><span class="count"></span>';
        row.querySelector('.count').textContent = String(entries.length);
        row.querySelector('input').addEventListener('change', event => { toggle(event.target.checked); row.classList.toggle('off', !event.target.checked); });
        controls.append(row, editor);
        toggle(true);
        edit.addEventListener('click', () => {
          editing = !editing; turning = null;
          if (editing) { toggle(true); row.querySelector('input').checked = true; row.classList.remove('off'); }
          onEditingChange?.(editing); refreshUser();
          status.textContent = editing ? 'Перетащите стрелку за опорную точку. Новое положение сохраняется автоматически.' : 'Корректировка завершена.';
        });
        retry.addEventListener('click', async () => {
          try { await reload(); status.textContent = 'Корректировки загружены.'; }
          catch (error) { status.textContent = 'Не удалось загрузить корректировки: ' + error.message; }
          refreshUser();
        });
        try { await reload(); status.textContent = 'Опорные точки закреплены по координатам. Корректирует префектура.'; }
        catch (error) { retry.hidden = false; status.textContent = 'Показан исходный слой. Корректировки недоступны: ' + error.message; }
        refreshUser();
        return { refreshUser, finishEditing() { editing = false; turning = null; refreshUser(); } };
      } catch (error) {
        const note = document.createElement('p'); note.className = 'direction-layer-note';
        note.textContent = 'Слой направлений съёмки не загрузился: ' + error.message;
        controls.append(note);
      }
    }
  };
}());
