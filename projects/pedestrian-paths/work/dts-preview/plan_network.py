"""Сравнение ракурсов общей сети по контрольным целям соседних фрагментов."""
import json
import math
from collections import Counter
from pathlib import Path

from shapely import STRtree, union_all
from shapely.geometry import Point, LineString
from build_preview import HERE, METRIC, GEOD, project, load_masks, buildings


def run():
    data = HERE / 'data'
    catalog = json.loads((data/'catalog.json').read_text(encoding='utf-8'))
    records = json.loads((data/'external-coverage.json').read_text(encoding='utf-8'))
    network = 'NET-00476'
    selected = [p for p in catalog['points'] if p['networkId'] == network]
    targets = {}
    for record in records:
        if record['routeId'].startswith(network+'-'):
            # Preserve every currently covered control target.
            for indexes in record['sampleIndicesByPoint'].values():
                for i in indexes:
                    targets[tuple(record['sampleCoordinates'][i])] = None
    coordinates = list(targets)
    samples = [project(Point(p), METRIC) for p in coordinates]
    masks, _ = load_masks(HERE/'parks-osm.geojson')
    walls, _ = buildings()
    obstacles = [m[0] for m in masks] + walls
    tree = STRtree(obstacles)
    candidates = []
    for point in selected:
        origin = project(Point(point['coordinates']), METRIC)
        rays = []
        for i, target in enumerate(samples):
            distance = origin.distance(target)
            if distance > 100:
                continue
            line = LineString([origin, target])
            if len(tree.query(line, predicate='intersects')):
                continue
            angle = GEOD.inv(*point['coordinates'], *coordinates[i])[0] % 360
            rays.append((i, angle))
        angles = {point['slots'][0]['azimuth']}
        for _, angle in rays:
            angles.update((angle, (angle+34.99)%360, (angle-34.99)%360))
        for angle in sorted(angles):
            hits = {i for i, bearing in rays if abs((bearing-angle+180)%360-180) <= 35}
            if hits:
                candidates.append((point, angle, hits))
    missing = set(range(len(samples)))
    chosen = []
    while missing and candidates:
        point, angle, hits = max(candidates, key=lambda c:len(c[2]&missing))
        if not hits & missing:
            break
        chosen.append(dict(pointId=point['id'], azimuth=round(angle,3), targets=sorted(hits)))
        missing -= hits
        candidates = [c for c in candidates if c[0]['id'] != point['id']]
    result = dict(networkId=network, before=len(selected), after=len(chosen),
                  samples=len(samples), uncovered=sorted(missing), chosen=chosen)
    (data/'network-00476-proposal.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(result,ensure_ascii=False))


if __name__ == '__main__':
    run()

