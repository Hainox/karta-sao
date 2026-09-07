/* Temporary, browser-only overlay for a district_change_set_v1 file. */
(function () {
  'use strict';

  const MAX_BYTES = 5 * 1024 * 1024;
  const MAX_BUNDLE_BYTES = 25 * 1024 * 1024;
  const input = document.getElementById('district-overlay-input');
  const toggle = document.getElementById('district-overlay-toggle');
  const clear = document.getElementById('district-overlay-clear');
  const status = document.getElementById('district-overlay-status');
  if (!input || !toggle || !clear || !status) return;
  const inputLabel = input.closest('label');
  const inputLabelText = inputLabel && inputLabel.querySelector('span');
  if (inputLabelText) inputLabelText.textContent = 'Наложить правки или сводку';

  const districtProposalOverlay = L.featureGroup();
  let boundary = null;
  let visible = false;

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[character]));
  }

  function setStatus(text, error) {
    status.innerHTML = error ? `<span style="color:#9b1c1c">${esc(text)}</span>` : text;
  }

  async function getBoundary() {
    if (boundary) return boundary;
    const response = await fetch('layers/sao_boundary_wgs84.geojson', { cache: 'no-store' });
    if (!response.ok) throw new Error(`граница САО: HTTP ${response.status}`);
    boundary = await response.json();
    return boundary;
  }

  function popup(feature) {
    const p = feature.properties || {};
    const type = p.change_type === 'queue' ? `${DistrictChanges.labelFor(p.change_type)} ${p.queue_priority}` : DistrictChanges.labelFor(p.change_type);
    return `<b>${esc(type)}</b><br><b>Район:</b> ${esc(p.district)}<br><b>Адрес:</b> ${esc(p.address)}${p.source_file ? `<br><b>Источник:</b> ${esc(p.source_file)}` : ''}${p.comment ? `<br><b>Комментарий:</b> ${esc(p.comment)}` : ''}<br><span style="color:#5a6872">Предложение района — не опубликовано</span>`;
  }

  function addFeature(feature) {
    const visual = DistrictChanges.styleFor(feature);
    const layer = L.geoJSON(feature, {
      style: { color: visual.color, weight: visual.weight || 4, dashArray: visual.dashArray || null, opacity: .96 },
      pointToLayer: (_, latlng) => L.circleMarker(latlng, { color: visual.color, fillColor: '#fff', fillOpacity: .95, weight: 3, radius: 8 })
    });
    layer.bindPopup(popup(feature));
    districtProposalOverlay.addLayer(layer);
  }

  function setVisible(nextVisible) {
    visible = nextVisible;
    if (visible) districtProposalOverlay.addTo(map);
    else map.removeLayer(districtProposalOverlay);
    toggle.textContent = visible ? 'Скрыть' : 'Показать';
  }

  function clearDistrictOverlay() {
    districtProposalOverlay.clearLayers();
    map.removeLayer(districtProposalOverlay);
    visible = false;
    toggle.disabled = true;
    clear.disabled = true;
    toggle.textContent = 'Скрыть';
    setStatus('Выберите GeoJSON района или сводный файл из приёмки.');
  }

  async function loadDistrictOverlay(file) {
    if (!file) return;
    if (file.size > MAX_BUNDLE_BYTES) {
      setStatus('Файл больше 25 МБ и не был наложен.', true);
      return;
    }
    try {
      setStatus('Проверяю файл…');
      const changeSet = JSON.parse(await file.text());
      const isReviewBundle = changeSet.review_bundle_version === 'district_review_bundle_v1';
      if (!isReviewBundle && file.size > MAX_BYTES) throw new Error('Файл района больше 5 МБ. Для сводки из приёмки допустимо до 25 МБ.');
      const validation = isReviewBundle ? DistrictChanges.validateReviewBundle(changeSet, await getBoundary()) : DistrictChanges.validate(changeSet, await getBoundary());
      if (!validation.valid) throw new Error(validation.errors.join('\n'));
      districtProposalOverlay.clearLayers();
      changeSet.features.forEach(addFeature);
      setVisible(true);
      toggle.disabled = false;
      clear.disabled = false;
      if (isReviewBundle) {
        const reviewed = changeSet.reviewed_at ? new Date(changeSet.reviewed_at).toLocaleString('ru-RU') : 'дата не указана';
        const sources = Array.isArray(changeSet.sources) ? changeSet.sources.length : 0;
        setStatus(`<b>Временное сводное наложение:</b> ${sources} файлов · ${esc(reviewed)}<br>Объектов: ${changeSet.features.length}. На опубликованные слои и GitHub это не влияет.`);
      } else {
        const created = changeSet.created_at ? new Date(changeSet.created_at).toLocaleString('ru-RU') : 'дата не указана';
        setStatus(`<b>Временное наложение:</b> ${esc(changeSet.district)} · ${esc(changeSet.author)} · ${esc(created)}<br>Объектов: ${changeSet.features.length}. На опубликованные слои и GitHub это не влияет.`);
      }
    } catch (error) {
      clearDistrictOverlay();
      setStatus(`Файл не принят: ${error.message}`, true);
    } finally {
      input.value = '';
    }
  }

  input.addEventListener('change', () => loadDistrictOverlay(input.files[0]));
  toggle.addEventListener('click', () => setVisible(!visible));
  clear.addEventListener('click', clearDistrictOverlay);
  window.clearDistrictOverlay = clearDistrictOverlay;
  setStatus('Выберите GeoJSON района или сводный файл из приёмки.');
}());
