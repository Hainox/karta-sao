"""Convert direction points to WGS84 and split by district without assigning nearest areas."""
import argparse
import hashlib
import json
import math
from pathlib import Path
from pyproj import Transformer
from shapely.geometry import Point, shape

ROOT = Path(__file__).resolve().parents[3]
SOURCE = Path(__file__).with_name('Ракурсы_180.geojson')
OUT = ROOT / 'districts/directions'

def build(source=SOURCE, output=OUT):
    raw = source.read_bytes()
    data = json.loads(raw.decode('utf-8-sig'))
    if data.get('type') != 'FeatureCollection' or not data.get('features'):
        raise ValueError('Ожидается непустой FeatureCollection')
    crs = data['crs']['properties']['name']
    transform = Transformer.from_crs(crs, 'EPSG:4326', always_xy=True)
    boundaries = []
    for path in sorted((ROOT / 'districts/layers').glob('*/boundary.geojson')):
        for feature in json.loads(path.read_text(encoding='utf-8'))['features']:
            boundaries.append((path.parent.name, feature['properties'].get('district') or feature['properties'].get('name'), shape(feature['geometry'])))
    groups, ids = {}, set()
    for feature in data['features']:
        properties = feature['properties']
        fid, azimuth = properties['fid'], properties['azimuth']
        if feature['geometry']['type'] != 'Point' or not isinstance(fid, int) or isinstance(fid, bool) or fid in ids:
            raise ValueError('Некорректный или повторный fid')
        if isinstance(azimuth, bool) or not isinstance(azimuth, (int, float)) or not math.isfinite(azimuth) or not 0 <= azimuth < 360:
            raise ValueError('Некорректный azimuth у fid ' + str(fid))
        lng, lat = transform.transform(*feature['geometry']['coordinates'], errcheck=True)
        # Nine decimals keep sub-millimetre precision and stable JSON across PROJ platforms.
        lng, lat = round(lng, 9), round(lat, 9)
        matches = [(slug, name) for slug, name, geom in boundaries if geom.covers(Point(lng, lat))]
        if len(matches) != 1:
            raise ValueError(f'fid {fid}: район определён неоднозначно: {matches}')
        slug, district = matches[0]
        ids.add(fid)
        groups.setdefault(slug, []).append({'type': 'Feature', 'id': 'direction180:' + str(fid), 'properties': {**properties, 'district': district}, 'geometry': {'type': 'Point', 'coordinates': [lng, lat]}})
    output.mkdir(parents=True, exist_ok=True)
    manifest = {'source': source.name, 'source_sha256': hashlib.sha256(raw).hexdigest(), 'source_crs': crs, 'coordinates': 'WGS84 longitude, latitude', 'azimuth': 'degrees clockwise from north; unchanged from source', 'total': len(ids), 'districts': {}}
    for slug, features in sorted(groups.items()):
        file = slug + '.geojson'
        (output / file).write_text(json.dumps({'type': 'FeatureCollection', 'features': features}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        manifest['districts'][slug] = {'count': len(features), 'file': file, 'district': features[0]['properties']['district']}
    (output / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(manifest, ensure_ascii=False))
    return manifest

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('source', nargs='?', type=Path, default=SOURCE)
    build(parser.parse_args().source)
