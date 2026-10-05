import json
import re
import subprocess
import zipfile
from pathlib import Path

from shapely.geometry import Point, shape


ROOT = Path(__file__).resolve().parents[1]


def data():
    markup = (ROOT / 'object-maps/tpu-parking.html').read_text(encoding='utf-8')
    return json.loads(re.search(r'<script id="map-data" type="application/json">(.*?)</script>', markup, re.S)[1])


def test_all_tpu_have_unique_source_ids_and_points_inside_contours():
    records = [r for r in data()['records'] if r['kind'] == 'tpu']
    assert len(records) == 29
    assert len({r['id'] for r in records}) == 29
    for record in records:
        assert record['kind'] == 'tpu'
        assert record['id'] == 'tpu:' + record['sourceNumber']
        assert shape(record['geometry']).covers(Point(record['lon'], record['lat']))
        assert record['group']
        assert record['properties']['Источник координат']
        assert shape(record['geometry']).is_valid
        assert 17 < record['coordinateCorrection']['distance_m'] < 18


def test_map_loads_excel_parking_and_supports_district_photo_packages():
    markup = (ROOT / 'object-maps/tpu-parking.html').read_text(encoding='utf-8')
    assert data()['parkingStatus'] == 'loaded'
    parking = [r for r in data()['records'] if r['kind'] == 'parking']
    assert len(parking) == len({r['id'] for r in parking}) == 65
    assert {r['sourceRow'] for r in parking} == set(range(1, 66))
    for record in parking:
        assert record['id'] == 'parking:' + record['sourceNumber']
        assert shape(record['geometry']).is_valid
        assert shape(record['geometry']).covers(Point(record['lon'], record['lat']))
        assert record['group']
    assert 'id="kindFilter"' in markup
    assert 'id="exportPhotos"' in markup
    assert 'Парковки нанесены по отдельному листу' in markup
    assert 'district-links.html' in markup
    assert '../object-maps/tpu-parking.html' in (ROOT / 'hub/index.html').read_text(encoding='utf-8')
    links = (ROOT / 'object-maps/district-links.html').read_text(encoding='utf-8')
    assert links.count('tpu-parking.html?district=') == 17
    assert 'photo-assignments.js' in markup
    assert 'id="assignmentAdd"' in markup
    assert 'id="assignmentLogin"' in markup


def test_zip_preserves_photo_bytes_point_binding_and_heic_formats(tmp_path):
    output = tmp_path / 'photos.zip'
    script = """
      const fs = require('node:fs');
      require(process.argv[1]);
      const record = {id:'tpu:800905601',sourceNumber:'800905601',group:'Ховрино',lat:55.8,lon:37.5};
      const photos = ['', 'application/octet-stream', 'image/heic-sequence', 'image/jpeg'].map((mime,index) => ({objectId:record.id,photo:new Blob([new Uint8Array([0,1,2,255])],{type:mime}),mimeType:mime,filename:index===3?'converted.heic':'original.heic',performer:'Тест',comment:'Привязка к точке'}));
      SaoPhotoPackage.create('sao_tpu_parking',[record],photos).then(async blob => fs.writeFileSync(process.argv[2],Buffer.from(await blob.arrayBuffer())));
    """
    subprocess.run(['node', '-e', script, str(ROOT / 'object-maps/photo-package.js'), str(output)], check=True)
    with zipfile.ZipFile(output) as archive:
        assert archive.testzip() is None
        manifest = json.loads(archive.read('manifest.json'))
        assert len(manifest['photos']) == 4
        for index, photo in enumerate(manifest['photos']):
            assert photo['pointId'] == 'tpu:800905601'
            assert photo['district'] == 'Ховрино'
            assert photo['file'].endswith('.jpg' if index == 3 else '.heic')
            assert archive.read(photo['file']) == bytes([0, 1, 2, 255])


def test_avd_receives_own_objects_and_geographic_districts_are_preserved():
    assigned = [r for r in data()['records'] if r['group'] == 'АвД САО']
    assert len(assigned) == 12
    assert sum(r['kind'] == 'tpu' for r in assigned) == 10
    assert sum(r['kind'] == 'parking' for r in assigned) == 2
    for record in assigned:
        assert record['properties']['Балансодержатель'] == 'АвД САО'
        assert record['properties']['Район'] != 'АвД САО'
    assert all(r['group'] != 'АвД САО' for r in data()['records'] if r['properties']['Балансодержатель'] != 'АвД САО')


def test_parking_responsibility_follows_balance_holder_and_contours_fit_yandex():
    records = data()['records']
    parking = [r for r in records if r['kind'] == 'parking']
    assert len(parking) == 65
    assert 'Требует назначения района' not in data()['districts']
    for record in records:
        holder = record['properties']['Балансодержатель']
        expected = 'АвД САО' if holder == 'АвД САО' else holder.replace('Жилищник ', '')
        assert record['group'] == expected
        shift = record['yandexAlignment']
        assert shift['method'] in {'local', 'global'}
        assert abs(shift['east_m']) <= 3.1 and abs(shift['north_m']) <= 3.1
    assert sum(r['group'] == 'АвД САО' and r['kind'] == 'parking' for r in records) == 2
