import hashlib
import importlib.util
import json
from pathlib import Path
from pyproj import Transformer
from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'projects/district-directions/work/Ракурсы_180.geojson'
OUT = ROOT / 'districts/directions'

def test_all_directions_keep_source_ids_azimuths_and_positions_in_the_right_district():
    manifest = json.loads((OUT / 'manifest.json').read_text(encoding='utf-8'))
    source = json.loads(SOURCE.read_text(encoding='utf-8-sig'))
    original = {f['properties']['fid']: f for f in source['features']}
    assert manifest['total'] == len(original) == 87
    assert manifest['source_sha256'] == hashlib.sha256(SOURCE.read_bytes()).hexdigest()
    assert {s: r['count'] for s, r in manifest['districts'].items()} == {'vostochnoe-degunino': 68, 'beskudnikovskiy': 19}
    inverse = Transformer.from_crs('EPSG:4326', source['crs']['properties']['name'], always_xy=True)
    found = set()
    for slug, district in manifest['districts'].items():
        output = json.loads((OUT / district['file']).read_text(encoding='utf-8'))
        boundary = json.loads((ROOT / 'districts/layers' / slug / 'boundary.geojson').read_text(encoding='utf-8'))
        polygons = [shape(f['geometry']) for f in boundary['features']]
        assert len(output['features']) == district['count']
        assert 'crs' not in output
        for feature in output['features']:
            fid = feature['properties']['fid']
            assert fid not in found
            found.add(fid)
            assert feature['id'] == 'direction180:' + str(fid)
            assert feature['properties']['azimuth'] == original[fid]['properties']['azimuth']
            point = Point(feature['geometry']['coordinates'])
            assert any(p.covers(point) for p in polygons)
            assert feature['properties']['district'] == district['district']
            before = original[fid]['geometry']['coordinates']
            restored = inverse.transform(*feature['geometry']['coordinates'])
            assert max(abs(a-b) for a,b in zip(before, restored)) < 0.00001
    assert found == set(original)

def test_generated_directions_are_reproducible(tmp_path):
    spec = importlib.util.spec_from_file_location('import_directions', ROOT / 'projects/district-directions/work/import_directions.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.build(SOURCE, tmp_path)
    for output in OUT.glob('*'):
        assert (tmp_path / output.name).read_bytes() == output.read_bytes()

def test_district_pages_keep_separate_direction_layer_hook_in_template():
    template = (ROOT / 'work/district_page_template.html').read_text(encoding='utf-8')
    assert 'SaoDistrictDirections.mount' in template
    for page in (ROOT / 'districts').glob('*.html'):
        if page.name == 'index.html': continue
        text = page.read_text(encoding='utf-8')
        assert 'direction-arrows.js?v=20261021' in text
        assert 'direction-arrows.css?v=20261021' in text
        assert 'SaoDistrictDirections.mount' in text
