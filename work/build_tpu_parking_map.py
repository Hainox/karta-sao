"""Build the TPU digitization map from workbook IDs and existing atlas contours."""
import argparse
import html
import json
import re
from pathlib import Path
from urllib.parse import quote

import openpyxl
from shapely.geometry import mapping, shape
from shapely.ops import unary_union
from tpu_geometry import correct_geometry, displacement_report, shift_geometry, yandex_offset, CORRECTION_METADATA


ROOT = Path(__file__).resolve().parents[1]


AVD_OWNER = 'АвД САО'


def responsible_for(holder, districts):
    """Photo responsibility follows the registry balance holder."""
    holder = (holder or '').strip()
    if holder.casefold() == AVD_OWNER.casefold():
        return AVD_OWNER
    if holder.startswith('Жилищник '):
        name = holder[len('Жилищник '):].strip()
        if name in districts:
            return name
    return None


def build_records(workbook):
    book = openpyxl.load_workbook(workbook, data_only=True, read_only=True)
    rows = [(kind, sheet, number, row) for kind, sheet in [('tpu', 'ТПУ'), ('parking', 'Парковки')] for number, row in enumerate(book[sheet].values, 1)]
    geometries = {}
    for path in sorted((ROOT / 'odh-map/layers').glob('sao_queue*_wgs84.geojson')):
        for feature in json.loads(path.read_text(encoding='utf-8'))['features']:
            geometries.setdefault(str(feature['properties']['id']), []).append(feature)
    districts = json.loads((ROOT / 'districts.geojson').read_text(encoding='utf-8'))['features']
    district_shapes = [(f['properties']['district'], shape(f['geometry'])) for f in districts]
    records = []
    for kind, sheet, row_number, (name, source_id) in rows:
        if not name and not source_id:
            continue
        if not isinstance(source_id, (int, float)) or int(source_id) != source_id or not isinstance(name, str):
            raise ValueError(f'Invalid object source row {row_number}')
        source_id = str(int(source_id))
        if source_id not in geometries:
            raise ValueError(f'No atlas geometry for object {source_id}')
        parts = geometries[source_id]
        east_m, north_m, fit_method = yandex_offset(source_id)
        full_geometry = unary_union([shape(shift_geometry(correct_geometry(f['geometry']), east_m, north_m)) for f in parts])
        contour = full_geometry.simplify(0.0000005, preserve_topology=True)
        polygons = list(contour.geoms) if contour.geom_type == 'MultiPolygon' else [contour]
        point = max(polygons, key=lambda g: g.area).representative_point()
        overlap = sorted(((district, full_geometry.intersection(g).area) for district, g in district_shapes), key=lambda x: x[1], reverse=True)
        district, area = overlap[0]
        if area <= 0:
            district = 'Требует назначения района'
        record = {
            'id': kind + ':' + source_id, 'kind': kind, 'lat': point.y, 'lon': point.x,
            'label': name, 'group': district, 'sourceNumber': source_id, 'sourceRow': row_number,
            'geometry': mapping(contour),
            'yandexAlignment': {'east_m': east_m, 'north_m': north_m, 'method': fit_method},
            'coordinateCorrection': displacement_report(mapping(unary_union([shape(f['geometry']) for f in parts]))),
            'properties': {
                'ID объекта': source_id, 'Тип': 'ТПУ' if kind == 'tpu' else 'Автомобильная парковка', 'Район': district,
                'Балансодержатель': parts[0]['properties'].get('customer', ''),
                'Источник списка': Path(workbook).name + ', лист «' + sheet + '», строка ' + str(row_number),
                'Источник координат': 'Контуры ОДХ атласа; пересчёт МСК-77 по преобразованию СММ; подгонка к подложке Яндекса ' + ('по контуру объекта' if fit_method == 'local' else 'общей поправкой') + f' ({east_m:+.2f} м восток, {north_m:+.2f} м север)',
                'Назначение района': 'По наибольшей площади пересечения контура с границами района' if area > 0 else 'Контур вне границ районов САО; ответственный район необходимо назначить вручную',
                'Точка фотофиксации': 'Места съёмки назначает префектура вручную; маркер объекта является ориентиром',
            },
            'issues': [] if area > 0 else ['Контур вне границ районов САО — требуется назначить ответственный район'], 'alternate': None,
            'searchKey': ' '.join([name, district, source_id, parts[0]['properties'].get('customer', '')]),
        }
        holder = record['properties']['Балансодержатель']
        owner = responsible_for(holder, {d for d, _ in district_shapes})
        if owner and owner != district:
            record['group'] = owner
            record['properties']['Ответственный за фото'] = owner
            record['properties']['Назначение района'] = (
                'Географический район сохранён; фотофиксация закреплена за балансодержателем ' + holder)
            record['searchKey'] += ' ' + owner
            record['issues'] = []
        elif owner:
            record['properties']['Ответственный за фото'] = owner
            record['properties']['Назначение района'] = 'По балансодержателю ' + holder + '; совпадает с районом по контуру'
        records.append(record)
    if len({r['id'] for r in records}) != len(records):
        raise ValueError('Duplicate object IDs in workbook')
    return records, district_shapes


def build(workbook):
    records, districts = build_records(workbook)
    data = {
        'datasetId': 'sao_tpu_parking', 'title': 'Оцифровка ТПУ и автомобильных парковок САО',
        'subtitle': '29 ТПУ · 65 автомобильных парковок · места съёмки назначает префектура',
        'groupLabel': 'Район', 'exportName': 'Yandex_TPU_parking.csv',
        'mapNote': 'Маркеры показывают объекты. Места съёмки назначает префектура вручную; синие нумерованные точки — задания для районов.',
        'parkingStatus': 'loaded', 'records': records, 'districts': sorted({d for d, _ in districts} | {r['group'] for r in records}),
        'coordinateCorrection': CORRECTION_METADATA,
        'exportGroups': [[r['id']] for r in records],
    }
    encoded = json.dumps(data, ensure_ascii=False, separators=(',', ':')).replace('<', '\\u003c')
    page = ROOT / 'object-maps/tpu-parking.html'
    # stops.html is now a module app, so refresh only the data block of the existing page.
    current = page.read_text(encoding='utf-8') if page.exists() else ''
    if '<script id="map-data" type="application/json">' in current:
        page.write_text(re.sub(r'(<script id="map-data" type="application/json">).*?(</script>)', lambda m: m[1] + encoded + m[2], current, count=1, flags=re.S), encoding='utf-8')
    else:
        build_page(encoded)
    write_links(records, districts)
    write_catalog(records)


def build_page(encoded):
    markup = (ROOT / 'object-maps/stops.html').read_text(encoding='utf-8')
    markup = re.sub(r'(<script id="map-data" type="application/json">).*?(</script>)', lambda m: m[1] + encoded + m[2], markup, flags=re.S)
    markup = markup.replace('<title>Карта</title>', '<title>Оцифровка ТПУ и парковок САО</title>')
    markup = markup.replace('<div class="top-actions">', '<div class="top-actions"><a class="district-link" href="district-links.html">Районы и АвД САО</a><button class="export-btn" id="exportPhotos" type="button">Скачать фото для передачи (ZIP)</button>')
    markup = markup.replace('<div class="filter-row">', '<label class="control-label" for="kindFilter">Вид объекта</label><select class="control" id="kindFilter"><option value="">ТПУ и парковки</option><option value="tpu">ТПУ</option><option value="parking">Автомобильные парковки</option></select><p class="small-note">Парковки нанесены по отдельному листу «Парковки» исходного Excel. Места съёмки назначаются вручную.</p><div class="filter-row">')
    markup = markup.replace('</style>', '[hidden]{display:none!important}.district-link{color:#d5eadc;font-weight:700;text-decoration:none}.top-actions{flex-wrap:wrap;justify-content:flex-end;gap:6px}.topbar{height:auto;min-height:76px;flex-basis:auto;padding-top:10px;padding-bottom:10px}.subtitle{max-width:600px}.map-key{max-width:calc(100% - 24px)}@media(max-width:850px){.topbar{align-items:flex-start;flex-direction:column}.top-actions{justify-content:flex-start}.subtitle{max-width:90vw}.workspace{grid-template-rows:minmax(210px,32vh) minmax(340px,1fr)}}\n</style>')
    markup = markup.replace('const reviewApi = localStorage.getItem("saoReviewApi") || "https://obhod-sao.ru/odh-api";', 'const reviewApi = ""; // Central district connection is a later stage.')
    markup = markup.replace('Array.from(new Set(DATA.records.map(record => record.group).filter(Boolean)))', 'Array.from(new Set(DATA.districts))')
    markup = markup.replace('class="filter-row"', 'class="filter-row" style="grid-template-columns:1fr 1fr"')
    markup = markup.replace('<label class="control-label" for="reviewFilter">', '<label hidden class="control-label" for="reviewFilter">')
    markup = markup.replace('<select class="control" id="reviewFilter">', '<select hidden class="control" id="reviewFilter">')
    markup = markup.replace('<span class="key-dot rework"></span>', '')
    markup = markup.replace('<span class="review-legend" id="reworkLegend">', '<span hidden class="review-legend" id="reworkLegend">')
    markup = markup.replace(' + " · на доработке: " + reworkCount.toLocaleString("ru-RU")', '')
    markup = markup.replace('mimeType:blob.type || file.type || "image/jpeg",', 'mimeType:blob.type || file.type || ({jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",heic:"image/heic",heif:"image/heif"}[file.name.split(".").pop().toLowerCase()] || "application/octet-stream"),')
    markup = markup.replace('const group = el("groupFilter").value;', 'const group = el("groupFilter").value;\n      const kind = el("kindFilter").value;')
    markup = markup.replace('if (group && record.group !== group) return false;', 'if (group && record.group !== group) return false;\n        if (kind && record.kind !== kind) return false;')
    markup = markup.replace('empty.textContent = "Ничего не найдено.";', 'empty.textContent = "В выбранном районе пока нет объектов. Проверьте фильтры.";')
    markup = markup.replace('select.appendChild(option);\n      }\n    }', 'select.appendChild(option);\n      }\n      const requested = new URLSearchParams(location.search).get("district");\n      if (requested && !groups.includes(requested)) { const option = document.createElement("option"); option.value = requested; option.textContent = requested; select.appendChild(option); }\n      if (requested) select.value = requested;\n    }', 1)
    markup = markup.replace('let pointLayer = null;', 'let pointLayer = null;\n    let contourLayer = null;')
    markup = markup.replace('if (!pointLayer) return;', 'if (!pointLayer) return;\n      if (contourLayer) { contourLayer.removeAll(); for (const record of filtered) { const raw = record.geometry; const coordinates = raw.coordinates.map(p => raw.type === "Polygon" ? p.map(c => [c[1],c[0]]) : p.map(r => r.map(c => [c[1],c[0]]))); const polygons = raw.type === "Polygon" ? [coordinates] : coordinates; for (const polygon of polygons) { const contour = new ymaps.Polygon(polygon, {}, {fillColor:"#0c7a5a18",strokeColor:"#0c7a5a",strokeWidth:2}); contour.events.add("click", () => openRecord(record)); contourLayer.add(contour); } } }')
    markup = markup.replace('map.geoObjects.add(pointLayer);', 'contourLayer = new ymaps.GeoObjectCollection();\n      map.geoObjects.add(contourLayer);\n      map.geoObjects.add(pointLayer);')
    markup = markup.replace('if (bounds) map.setBounds(bounds, {checkZoomRange:true, zoomMargin:24});', 'const requestedDistrict = el("groupFilter").value;\n      const districtRecords = DATA.records.filter(r => !requestedDistrict || r.group === requestedDistrict);\n      if (districtRecords.length) { const lats = districtRecords.map(r => r.lat), lons = districtRecords.map(r => r.lon); map.setBounds([[Math.min(...lats),Math.min(...lons)],[Math.max(...lats),Math.max(...lons)]], {checkZoomRange:true, zoomMargin:24}); } else if (bounds) map.setBounds(bounds, {checkZoomRange:true, zoomMargin:24});')
    markup = markup.replace('initEvents();', '''el("kindFilter").addEventListener("change", updateMapAndList);
    el("exportPhotos").addEventListener("click", async () => {
      const button = el("exportPhotos");
      if (!state.storageReady) { showToast("Локальная база фото недоступна.", true); return; }
      button.disabled = true;
      button.textContent = "Готовим архив…";
      try {
        const records = filteredRecords();
        const photos = [];
        for (const record of records) photos.push(...await getPhotos(objectKey(record.id)));
        const blob = await SaoPhotoPackage.create(DATA.datasetId, records, photos);
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "SAO_TPU_parking_" + (el("groupFilter").value || "all") + "_" + new Date().toISOString().slice(0,10) + ".zip";
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast("Архив подготовлен: " + records.length + " объектов, " + photos.length + " фото. Передайте его для приёмки.");
      } catch (error) { showToast("Не удалось создать архив: " + error.message, true); }
      finally { button.disabled = false; button.textContent = "Скачать фото для передачи (ZIP)"; }
    });
    initEvents();''', 1)
    markup = markup.replace('loadPhotoCounts();\n    loadReviewStatuses();', 'loadPhotoCounts().then(() => { const requestedObject = new URLSearchParams(location.search).get("object"); if (byId.has(requestedObject)) openRecord(byId.get(requestedObject)); });\n    loadReviewStatuses();')
    markup = markup.replace('  <script>\n  (() =>', '  <script src="photo-package.js"></script>\n  <script>\n  (() =>')
    markup = add_photo_assignments(markup)
    (ROOT / 'object-maps/tpu-parking.html').write_text(markup, encoding='utf-8')



def write_catalog(records):
    """Object list for the prefecture TPU report on the photo service."""
    catalog = [{'id': r['id'], 'kind': r['kind'], 'label': r['label'], 'sourceNumber': r['sourceNumber'],
                'group': r['group'], 'district': r['properties']['Район'],
                'holder': r['properties']['Балансодержатель']} for r in records]
    text = json.dumps(catalog, ensure_ascii=False, indent=1) + '\n'
    for folder in ('api/lib', 'photo-service/src/tpu-points'):
        (ROOT / folder / 'tpu-objects.json').write_text(text, encoding='utf-8')


def write_links(records, districts):
    cards = []
    for district in sorted({d for d, _ in districts} | {r['group'] for r in records}):
        count = sum(r['group'] == district and r['kind'] == 'tpu' for r in records)
        parking_count = sum(r['group'] == district and r['kind'] == 'parking' for r in records)
        cards.append(f'<a class="card" href="tpu-parking.html?district={quote(district)}"><strong>{html.escape(district)}</strong><span>ТПУ: {count} · парковки: {parking_count}</span></a>')
    (ROOT / 'object-maps/district-links.html').write_text('''<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Оцифровка ТПУ и парковок — ссылки районов</title><style>body{margin:0;background:#f5f5ef;color:#183c35;font:16px/1.5 "Segoe UI",Arial,sans-serif}main{max-width:1040px;margin:30px auto;padding:24px}a{color:#0c7a5a}h1{font-size:28px}.cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:24px}.card{padding:18px;border:1px solid #d9e0da;border-radius:12px;background:white;text-decoration:none}.card strong,.card span{display:block}.card span{color:#687873;font-size:13px;margin-top:8px}@media(max-width:700px){.cards{grid-template-columns:1fr}main{margin:0;padding:18px}}</style></head><body><main><a href="../hub/">← Атлас САО</a><h1>Оцифровка ТПУ и автомобильных парковок</h1><p>Выберите район, откройте точку и добавьте фотографию. Фото сохраняются в вашем браузере. Для передачи фотографий скачайте ZIP на карте и отправьте его для приёмки.</p><p>Это подготовительная база: места съёмки и распределение по районам требуют согласования. Подключение к общей базе будет следующим этапом.</p><a href="tpu-parking.html">Открыть все объекты →</a><div class="cards">''' + '\n'.join(cards) + '</div></main></body></html>', encoding='utf-8')
    links_path = ROOT / 'object-maps/district-links.html'
    links = links_path.read_text(encoding='utf-8').replace(
        'Выберите район, откройте точку и добавьте фотографию. Фото сохраняются в вашем браузере. Для передачи фотографий скачайте ZIP на карте и отправьте его для приёмки.',
        'Выберите район или АвД САО и войдите под учётной записью оцифровки. Откройте объект, выберите назначенную точку съёмки и отправьте фотографию. Доступ ограничен объектами вашей учётной записи.',
    ).replace(
        'Это подготовительная база: места съёмки и распределение по районам требуют согласования. Подключение к общей базе будет следующим этапом.',
        'Места съёмки назначает префектура вручную. Назначенные точки видны на карте без входа. Для отправки фото войдите в учётную запись фотослужбы.',
    )
    links_path.write_text(links, encoding='utf-8')
    print(f'Built {sum(r["kind"] == "tpu" for r in records)} TPU, {sum(r["kind"] == "parking" for r in records)} parking, {len(districts)} district links')


def add_photo_assignments(markup):
    markup = markup.replace('</head>', '<link rel="stylesheet" href="photo-assignments.css"></head>')
    markup = markup.replace('<div class="list-head">', '''<section class="assignment-login" aria-label="Учётная запись">
      <div class="assignment-session" id="assignmentSession"></div>
      <details id="assignmentAccount"><summary>Войти для назначения точек и отправки фото</summary><form id="assignmentLogin"><label for="assignmentEmail">Логин оцифровки</label><input id="assignmentEmail" autocomplete="username" required>
      <label for="assignmentPassword">Пароль</label><input id="assignmentPassword" type="password" autocomplete="current-password" required>
      <button class="save-btn" type="submit">Войти</button></form></details>
      <button class="secondary-btn" id="assignmentLogout" type="button" hidden>Выйти</button>
      <p class="assignment-status" id="assignmentStatus" role="status" aria-live="polite"></p></section><div class="list-head">''')
    markup = markup.replace('<div id="map" role=', '''<section class="assignment-picker" id="assignmentPicker" hidden><h3>Назначить точку съёмки</h3><p id="assignmentObject"></p>
      <form id="assignmentForm"><label for="assignmentLabel">Название точки</label><input id="assignmentLabel" maxlength="160" placeholder="Например: вход со стороны улицы" required>
      <label for="assignmentNote">Что сфотографировать</label><textarea id="assignmentNote" maxlength="2000" rows="2"></textarea><p id="assignmentCoords">Нажмите на карте в месте съёмки</p><p id="assignmentDirection" aria-live="polite">Шаг 1: поставьте точку на карте.</p><button class="secondary-btn" id="assignmentMove" type="button">Переставить точку</button>
      <div class="form-actions"><button class="save-btn" id="assignmentSave" type="submit" disabled>Сохранить точку</button><button class="secondary-btn" id="assignmentCancel" type="button">Отмена</button></div></form></section><div id="map" role=''')
    markup = markup.replace('<div class="section-title">Добавить фотофиксацию</div>', '''<section id="assignmentPanel"><div class="section-title">Назначенные точки съёмки</div><button class="save-btn" id="assignmentAdd" type="button" hidden>Назначить точку на карте</button><div id="assignmentList"></div></section>
      <div hidden class="section-title">Локальный черновик фото</div>''')
    markup = markup.replace('<form class="photo-form" id="photoForm">', '<form hidden class="photo-form" id="photoForm">')
    markup = markup.replace('<div class="section-title">Сохранённые фото</div>', '<div hidden class="section-title">Сохранённые локально фото</div>')
    markup = markup.replace('<div class="gallery" id="gallery">', '<div hidden class="gallery" id="gallery">')
    markup = markup.replace('<div class="footer-note">Яндекс Карты · фото и карточки объектов хранятся в этом браузере.</div>', '<div class="footer-note">Фото назначенных точек отправляются в общую базу после входа.</div>')
    markup = markup.replace('Скачать фото для передачи (ZIP)', 'Скачать локальный архив (ZIP)')
    markup = markup.replace('  <script src="photo-package.js">', '  <script src="../odh-map/api-config.js"></script><script>if (["127.0.0.1", "localhost"].includes(location.hostname)) ODHApi.setBase("http://127.0.0.1:8789");</script><script src="tpu-photo-api.js"></script><script src="photo-assignments.js"></script>\n  <script src="photo-package.js">')
    markup = markup.replace('let contourLayer = null;', 'let contourLayer = null;\n    let assignments = null;')
    markup = markup.replace('if (group && record.group !== group) return false;', 'if (group && record.group !== group) return false;\n        const account = (window.TpuPhotoApi || ODHApi).user(); if (account?.role === "district_editor" && account.district !== record.group) return false;')
    markup = markup.replace('contour.events.add("click", () => openRecord(record));', 'contour.events.add("click", event => { if (!assignments?.pick(event.get("coords"))) openRecord(record); });')
    markup = markup.replace('if (record) openRecord(record);', 'if (record && !assignments?.pick(event.get("coords") || [record.lat,record.lon])) openRecord(record);')
    markup = markup.replace('    function focusRecord(record)', '    function focusRecord(record)')
    markup = markup.replace('      updateMapAndList();\n    }\n\n    function focusRecord', '      updateMapAndList();\n      assignments?.mapReady();\n    }\n\n    function focusRecord')
    markup = markup.replace('      state.selected = record;', '      state.selected = record;\n      assignments?.open(record);')
    markup = markup.replace('      el("photoInput").focus({preventScroll:true});', '')
    markup = markup.replace('    if (window.ymaps) ymaps.ready(initMap);', '''    assignments = SaoPhotoAssignments.mount({ dataset: DATA, getMap: () => map, notify: showToast, openRecord, closeRecord,
      applyScope(user) { const filter = el("groupFilter"); filter.disabled = user?.role === "district_editor"; if (filter.disabled) { filter.value = user.district; if (state.selected && state.selected.group !== user.district) closeRecord(); } updateMapAndList(); },
      onChange(points) { state.assignedPhotoCounts = new Map(); for (const point of points) state.assignedPhotoCounts.set(point.object_key, (state.assignedPhotoCounts.get(point.object_key) || 0) + Number(point.photo_count || 0)); updatePhotoCount(); updateMapAndList(); }
    });
    if (window.ymaps) ymaps.ready(initMap);''')
    markup = markup.replace('      assignments?.mapReady();', '      assignments?.mapReady();\n      const object = byId.get(new URLSearchParams(location.search).get("object")); if (object) map.setCenter([object.lat,object.lon],18);')
    markup = markup.replace('function initMap() {', 'async function initMap() {')
    markup = markup.replace('map.setBounds(', 'await map.setBounds(')
    markup = markup.replace('if (object) map.setCenter([object.lat,object.lon],18);', 'if (object) map.setCenter([object.lat,object.lon],18);\n      const view = (new URLSearchParams(location.search).get("view") || "").split(",").map(Number); if (view.length === 3 && view.every(Number.isFinite) && Math.abs(view[0]) <= 90 && Math.abs(view[1]) <= 180 && view[2] >= 9 && view[2] <= 21) map.setCenter(view.slice(0,2),view[2]);')
    markup = markup.replace('for (const value of state.photoCounts.values())', 'for (const value of (state.assignedPhotoCounts || new Map()).values())')
    markup = markup.replace('return state.photoCounts.get(record.id) || 0;', 'return state.assignedPhotoCounts?.get(record.id) || 0;')
    markup = markup.replace('const filtered = filteredRecords();', 'const filtered = filteredRecords();\n      assignments?.filter(filtered);')
    markup = markup.replace('loadPhotoCounts().then(() => { const requestedObject = new URLSearchParams(location.search).get("object"); if (byId.has(requestedObject)) openRecord(byId.get(requestedObject)); });', 'loadPhotoCounts();\n    const requestedObject = new URLSearchParams(location.search).get("object"); if (byId.has(requestedObject)) openRecord(byId.get(requestedObject));')
    markup = markup.replace('Фото хранятся в этом браузере', 'Фото по назначенным точкам')
    return markup


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('workbook', type=Path)
    build(parser.parse_args().workbook)
