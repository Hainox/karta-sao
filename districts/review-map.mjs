import { captureLocation, distanceMeters, photoGps } from './review-location.mjs';

let maps;
function loadMaps() {
  return maps ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://api-maps.yandex.ru/2.1/?apikey=6b197a0e-9109-4624-9520-954a47c26dda&lang=ru_RU';
    const timeout = setTimeout(() => reject(new Error('map timeout')), 10000);
    script.onerror = () => { clearTimeout(timeout); reject(new Error('map unavailable')); };
    script.onload = () => window.ymaps.ready(() => { clearTimeout(timeout); resolve(window.ymaps); }, reject);
    document.head.append(script);
  }).catch(error => { maps = null; throw error; });
}

export function mountReviewMap(panel, row) {
  const { point, heading, gps: suppliedGps } = captureLocation(row);
  let map, player, photoMark, line, sdk, gps = suppliedGps, closed = false, panoramaRun = 0;
  const by = name => panel.querySelector('[data-map="' + name + '"]');
  const mapHost = by('map'), panoHost = by('pano'), panoButton = by('open'), back = by('back');
  const status = by('status'), detail = by('detail');
  panel.hidden = false;
  by('arrow').style.transform = 'rotate(' + (heading ?? 0) + 'deg)';
  by('arrow').hidden = heading == null;
  by('bearing').textContent = heading == null ? 'Азимут не задан' : 'Направление кадра: ' + heading.toLocaleString('ru-RU') + '°';
  function updateGps() {
    detail.textContent = gps && point ? 'GPS фото: ' + gps.map(n => n.toFixed(6)).join(', ') + ' · ' + Math.round(distanceMeters(point, gps)) + ' м от точки' : 'GPS фото не указан';
    if (!gps || !map || !sdk || photoMark) return;
    photoMark = new sdk.Placemark(gps, { hintContent: 'Место съёмки по GPS фото' }, { preset: 'islands#redDotIcon' });
    line = new sdk.Polyline([point, gps], {}, { strokeColor: '#c93558', strokeWidth: 2, strokeStyle: 'dash' });
    map.geoObjects.add(line).add(photoMark);
    if (distanceMeters(point, gps) > 10) map.setBounds(map.geoObjects.getBounds(), { checkZoomRange: true, zoomMargin: 35 });
  }
  updateGps();
  const showMap = () => {
    panoramaRun++;
    player?.destroy();
    player = null;
    panoHost.hidden = back.hidden = true;
    mapHost.hidden = false;
    panoButton.hidden = !map;
    map?.container.fitToViewport();
  };
  back.onclick = () => { showMap(); status.textContent = ''; };
  panoButton.onclick = async () => {
    const run = ++panoramaRun;
    panoButton.disabled = true;
    status.textContent = 'Ищем ближайшую панораму…';
    try {
      const panoramas = await sdk.panorama.locate(point);
      if (closed || run !== panoramaRun) return;
      const panorama = panoramas.find(item => distanceMeters(point, item.getPosition()) <= 100);
      if (!panorama) { status.textContent = 'Панорамы в пределах 100 м нет. Оставляем карту.'; return; }
      panoHost.hidden = false;
      mapHost.hidden = true;
      back.hidden = false;
      const opened = await panorama.createPlayer(panoHost, heading == null ? {} : { direction: [heading, 0] });
      if (closed || run !== panoramaRun) { opened.destroy(); return; }
      player = opened;
      panoButton.hidden = true;
      status.textContent = 'Панорама Яндекса · ' + Math.round(distanceMeters(point, panorama.getPosition())) + ' м от точки';
    } catch {
      if (closed || run !== panoramaRun) return;
      showMap();
      status.textContent = 'Панорама недоступна. Можно сверить направление на карте.';
    } finally { if (!closed) panoButton.disabled = false; }
  };
  showMap();
  status.textContent = point ? 'Загружаем мини-карту…' : 'Координаты точки не указаны.';
  if (point) loadMaps().then(ymaps => {
    if (closed) return;
    sdk = ymaps;
    map = new sdk.Map(mapHost, { center: point, zoom: 17, controls: ['zoomControl'] }, { suppressMapOpenBlock: true });
    const icon = heading == null ? {} : {
      iconLayout: 'default#image',
      iconImageHref: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 42 42"><g transform="rotate(' + heading + ' 21 21)"><path d="M21 2 34 27 21 22 8 27Z" fill="#1662be" stroke="white" stroke-width="2"/><circle cx="21" cy="21" r="4" fill="#0c7a5a" stroke="white" stroke-width="2"/></g></svg>'),
      iconImageSize: [42, 42], iconImageOffset: [-21, -21],
    };
    const marker = new sdk.Placemark(point, { hintContent: 'Точка задания · открыть панораму' }, icon);
    marker.events.add('click', () => { if (!panoButton.disabled) panoButton.click(); });
    map.geoObjects.add(marker);
    updateGps();
    status.textContent = '';
    panoButton.hidden = false;
  }).catch(() => { if (!closed) status.textContent = 'Мини-карта недоступна. Направление указано выше.'; });

  return {
    async readPhoto(blob) {
      if (closed || gps) return;
      const found = photoGps(await blob.arrayBuffer());
      if (!closed && found) { gps = found; updateGps(); }
    },
    destroy() {
      closed = true;
      showMap();
      map?.destroy();
      map = null;
      mapHost.replaceChildren();
      panoHost.replaceChildren();
      panel.hidden = true;
    },
  };
}
