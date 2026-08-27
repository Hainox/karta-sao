from pathlib import Path
import collections
import json
import re

import openpyxl
from shapely.geometry import Point, shape

ROOT = Path(r'C:\Users\root\Downloads\КАРТА')
SOURCE = Path(r'C:\Users\root\Downloads\Места хранения СММ Зима.xlsx')
LAYER_PATH = ROOT / 'odh-map' / 'layers' / 'sao_smm_storage_locations_wgs84.geojson'

book = openpyxl.load_workbook(SOURCE, data_only=True, read_only=True)
sheet = book.worksheets[0]
locations = collections.defaultdict(list)
source_rows = 0
for row_number, row in enumerate(sheet.iter_rows(min_row=2, values_only=True), 2):
    if not row or len(row) < 9:
        continue
    coord = str(row[8] or '').strip()
    if not re.fullmatch(r'\d+(?:\.\d+)?\s*,\s*\d+(?:\.\d+)?', coord):
        continue
    lat, lon = map(float, coord.split(','))
    # The register fields: district, serviced address, section, unit count,
    # winter storage location, and coordinate of that storage location.
    district = str(row[1] or '').strip()
    serviced_address = str(row[2] or '').strip()
    section = str(row[3] or '').strip()
    try:
        units = int(float(str(row[4]).strip()))
    except (TypeError, ValueError):
        units = 1
    address = str(row[5] or '').strip()
    locations[(lon, lat, address, district)].append({
        'row': row_number,
        'section': section,
        'serviced_address': serviced_address,
        'units': units,
    })
    source_rows += 1

boundary = shape(json.loads((ROOT / 'odh-map' / 'layers' / 'sao_boundary_wgs84.geojson').read_text(encoding='utf-8'))['features'][0]['geometry'])
features, excluded = [], []
for number, ((lon, lat, address, district), rows) in enumerate(sorted(locations.items(), key=lambda x: (x[0][3], x[0][2], x[0][1], x[0][0])), 1):
    point = Point(lon, lat)
    if not boundary.covers(point):
        excluded.append({'address': address, 'district': district, 'longitude': lon, 'latitude': lat, 'source_rows': len(rows)})
        continue
    sections = sorted({r['section'] for r in rows if r['section']})
    features.append({
        'type': 'Feature',
        'properties': {
            'name': f'Место хранения СММ № {number}',
            'address': address or 'Адрес не указан в реестре',
            'district': district,
            'section': ', '.join(sections),
            'smm_units': sum(r['units'] for r in rows),
            'source_rows': len(rows),
            'purpose': 'Место хранения СММ в зимний период',
            'coordinate_status': 'Координата из реестра мест хранения СММ',
            'verification': 'Требуется служебная сверка перед утверждением',
            'source': 'Места хранения СММ Зима.xlsx',
        },
        'geometry': {'type': 'Point', 'coordinates': [lon, lat]},
    })

payload = {
    'type': 'FeatureCollection',
    'name': 'sao_smm_storage_locations_wgs84',
    'metadata': {
        'source': 'Места хранения СММ Зима.xlsx, первый лист',
        'coordinate_order': '[longitude, latitude] (WGS84 / CRS84)',
        'source_rows_with_coordinates': source_rows,
        'unique_locations_inside_sao': len(features),
        'unique_locations_excluded_outside_sao': len(excluded),
        'note': 'Точки созданы по координатам реестра; точность и режим хранения требуют служебной сверки.',
    },
    'features': features,
}
LAYER_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
(ROOT / 'work' / 'smm_storage_import_audit.json').write_text(json.dumps({'imported': len(features), 'excluded': excluded}, ensure_ascii=False, indent=2), encoding='utf-8')

manifest_path = ROOT / 'odh-map' / 'layers.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['layers'] = [x for x in manifest['layers'] if x['key'] != 'smm_storage']
insert_at = next(i for i, x in enumerate(manifest['layers']) if x['key'] == 'hydrants')
manifest['layers'].insert(insert_at, {
    'key': 'smm_storage',
    'name': f'Места хранения СММ ({len(features)} площадки)',
    'color': '#6a1b9a',
    'default': False,
    'url': 'layers/sao_smm_storage_locations_wgs84.geojson',
})
manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')

page_path = ROOT / 'odh-map' / 'index.html'
page = page_path.read_text(encoding='utf-8')
symbol = '"smm_storage":"<svg data-kind=\\"smm-storage\\" viewBox=\\"0 0 24 24\\" aria-hidden=\\"true\\" style=\\"--symbol-color:#6a1b9a\\" fill=\\"none\\" stroke=\\"var(--symbol-color)\\" stroke-width=\\"1.8\\" stroke-linecap=\\"round\\" stroke-linejoin=\\"round\\"><path d=\\"M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6M7 10h2M15 10h2\\"/><path d=\\"M4 13h3M17 13h3\\"/><path d=\\"M12 6v5\\"/><\\/svg>",'
page = page.replace('"hydrants":"<svg', symbol + '"hydrants":"<svg')
control = f'<label class="layer-toggle"><input type="checkbox" data-key="smm_storage" onchange="toggleLayer(this)"><span class="layer-swatch" style="color:#6a1b9a"><svg data-kind="smm-storage" viewBox="0 0 24 24" aria-hidden="true" style="--symbol-color:#6a1b9a" fill="none" stroke="var(--symbol-color)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6M7 10h2M15 10h2"/><path d="M4 13h3M17 13h3"/><path d="M12 6v5"/></svg></span><span>Места хранения СММ ({len(features)} площадки)</span><span class="layer-count">{len(features)}</span></label><p class="layer-note">Координаты и привязка — из реестра «Места хранения СММ Зима»; перед утверждением требуется служебная сверка.</p>'
needle = '<label class="layer-toggle"><input type="checkbox" data-key="hydrants"'
if 'data-key="smm_storage"' not in page:
    page = page.replace(needle, control + needle)
page = page.replace("facility_type:'Тип учреждения'", "facility_type:'Тип учреждения',smm_units:'Количество СММ',source_rows:'Строк реестра',section:'Участок',purpose:'Назначение'")
page = page.replace("'facility_type']);", "'facility_type','smm_units','source_rows','section']);")
page_path.write_text(page, encoding='utf-8')
print(f'Imported {len(features)} locations from {source_rows} source rows; excluded outside SAO: {len(excluded)}')
