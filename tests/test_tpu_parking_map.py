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


def test_map_only_contains_tpu_and_preserves_district_photo_workflow():
    markup = (ROOT / 'object-maps/tpu-parking.html').read_text(encoding='utf-8')
    assert data()['parkingStatus'] == 'excluded'
    assert len(data()['records']) == 29
    assert all(record['kind'] == 'tpu' for record in data()['records'])
    assert len(data()['exportGroups']) == 29
    assert all(group[0].startswith('tpu:') for group in data()['exportGroups'])
    assert 'id="kindFilter"' not in markup
    assert 'id="exportPhotos"' in markup
    assert 'В задания входят только ТПУ' in markup
    assert 'district-links.html' in markup
    hub = (ROOT / 'hub/index.html').read_text(encoding='utf-8')
    assert '../object-maps/tpu-parking.html' in hub
    assert 'Оцифровка ТПУ и автомобильных парковок' not in hub
    links = (ROOT / 'object-maps/district-links.html').read_text(encoding='utf-8')
    assert links.count('tpu-parking.html?district=') == 17
    assert 'парковки:' not in links
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
    assert len(assigned) == 10
    assert sum(r['kind'] == 'tpu' for r in assigned) == 10
    assert all(r['kind'] == 'tpu' for r in assigned)
    for record in assigned:
        assert record['properties']['Балансодержатель'] == 'АвД САО'
        assert record['properties']['Район'] != 'АвД САО'
    assert all(r['group'] != 'АвД САО' for r in data()['records'] if r['properties']['Балансодержатель'] != 'АвД САО')
