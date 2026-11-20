"""Сборка автономного просмотра. Открыть review-map/index.html с диска."""
import json
import hashlib
import shutil
from collections import defaultdict
from pathlib import Path

from shapely.geometry import shape

HERE = Path(__file__).resolve().parent
LAYERS = HERE.parents[3] / 'districts' / 'layers'
OUT = HERE / 'review-map'
DATA = HERE / 'data'


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def js(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def lines(geometry):
    """Результат — отдельные линии или кольца для отрисовки на карте."""
    if geometry.geom_type == 'Polygon':
        return [list(geometry.exterior.coords), *(list(r.coords) for r in geometry.interiors)]
    if geometry.geom_type == 'LineString':
        return [list(geometry.coords)]
    if geometry.geom_type == 'Point':
        return [list(geometry.coords)]
    if hasattr(geometry, 'geoms'):
        return [seq for child in geometry.geoms for seq in lines(child)]
    return []


def compact(geometry):
    return [[[round(x, 7), round(y, 7)] for x, y in seq] for seq in lines(geometry)]


def main():
    OUT.mkdir(exist_ok=True)
    original = load(HERE / 'original-api.json')['points']
    proposed = load(DATA / 'catalog.json')['points']
    grouped = defaultdict(lambda: dict(before=[], after=[], paths=[], axes=[], cuts=[], masks=[]))
    ids = defaultdict(set)
    masks = defaultdict(set)
    for key, points in [('before', original), ('after', proposed)]:
        for p in points:
            grouped[p['district']][key].append(dict(id=p['id'], xy=p['coordinates'], src=str(p['sourceId']),
                frames=[[s['id'], s['azimuth']] for s in p['slots']], route=p.get('routeId'), rule=p.get('rule'),
                station=p.get('station_m')))
            ids[p['district']].add(str(p['sourceId']))
    for file, key in [('routes.geojson', 'axes'), ('excluded.geojson', 'cuts')]:
        for f in load(DATA / file)['features']:
            p = f['properties']
            geom = shape(f['geometry'])
            coords = compact(geom)
            if coords:
                grouped[p['district']][key].append(dict(src=str(p['sourceId']), lines=coords,
                    rule=p.get('kind') or p.get('rule'), route=p.get('routeId'), detail=p.get('reason', ''),
                    area=geom.area if key=='cuts' else p.get('area_m2',0), length=p.get('length_m'),
                    mask=p.get('maskId')))
            if key=='cuts':
                masks[(p['kind'], str(p['maskId']))].add(p['district'])
    districts = []
    for folder in sorted(LAYERS.iterdir()):
        if not (folder / 'paths.geojson').is_file():
            continue
        for f in load(folder / 'paths.geojson')['features']:
            p = f['properties']
            name = p.get('district')
            src = str(p.get('id'))
            if name not in grouped or src not in ids[name]:
                continue
            geom = shape(f['geometry'])
            grouped[name]['paths'].append(dict(src=src, address=p.get('parent_object_name', ''),
                                               lines=compact(geom)))
    for kind in ('dp', 'sp', 'park'):
        sources = [HERE / 'parks-osm.geojson'] if kind=='park' else sorted(LAYERS.glob('*/'+kind+'.geojson'))
        included = set()
        for source in sources:
            for feature in load(source)['features']:
                key = str(feature['properties'].get('id'))
                if key in included or (kind,key) not in masks:
                    continue
                included.add(key)
                for name in masks[(kind,key)]:
                    grouped[name]['masks'].append(dict(rule=kind, mask=key, lines=compact(shape(feature['geometry']))))
    stamp = hashlib.sha256((DATA/'catalog.json').read_bytes()).hexdigest()[:16]
    for i, (district, data) in enumerate(sorted(grouped.items())):
        data['revision'] = stamp
        byroute = defaultdict(list)
        for p in data['after']:
            byroute[p['route']].append(p)
        for rule in ('short','long','compact','branched'):
            options = [f for f in data['axes'] if f['rule']==rule and byroute[f['route']]]
            if rule=='short':
                options = [f for f in options if len(byroute[f['route']])==1]
            if rule=='long':
                options = [f for f in options if any(p['station'] is not None and p['station'] >=99.9 for p in byroute[f['route']])]
            if options:
                max(options,key=lambda f:f['length'])['example'] = True
        for kind in ('dp','sp','park'):
            options = [f for f in data['cuts'] if f['rule']==kind]
            if options:
                max(options,key=lambda f:f['area'])['example'] = True
        filename = f'district-{i:02}.js'
        (OUT / filename).write_text('showDistrict(' + js(data) + ');', encoding='utf-8')
        districts.append([district, filename])
    shutil.copyfile(HERE / 'review.html', OUT / 'index.html')
    (OUT / 'districts.js').write_text('const districts=' + js(districts) + ';', encoding='utf-8')
    print(f'{len(districts)} районов, {len(original)} исходных и {len(proposed)} расчётных точек')


if __name__ == '__main__':
    main()
