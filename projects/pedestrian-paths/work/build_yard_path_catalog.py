from pathlib import Path
import argparse
import hashlib
import json
import sqlite3
import struct

def build(source):
    with sqlite3.connect(source) as db:
        db.row_factory = sqlite3.Row
        tables = db.execute("SELECT table_name FROM gpkg_contents WHERE data_type='features'").fetchall()
        assert len(tables) == 1, 'Expected a single points table'
        name = tables[0][0].replace('"', '""')
        rows = db.execute('SELECT * FROM "' + name + '" ORDER BY point_id').fetchall()
    points = []
    for row in rows:
        blob = row['geom']
        assert blob[:2] == b'GP' and blob[3] == 1 and blob[8:13] == b'\x01\x01\x00\x00\x00'
        assert struct.unpack_from('<i', blob, 4)[0] == 4326
        lng, lat = struct.unpack_from('<dd', blob, 13)
        assert 37.2 <= lng < 37.8 and 55.7 <= lat < 56.05
        angles = [float(a) % 360 for a in row['all_azimuths'].split(';')]
        assert len(angles) == row['photo_slots'] and 1 <= len(angles) <= 6
        for index, key in enumerate(('azimuth_1', 'azimuth_2')):
            if index < len(angles) and row[key] is not None:
                angles[index] = row[key] % 360
        point_id = row['point_id']
        points.append(dict(id=point_id, district=row['district'], street=row['source_id'], taskId=row['source_piece'],
            balance=row['district'], coordinates=[lng, lat], slots=[dict(id=f'{point_id}-{i+1}', azimuth=a) for i,a in enumerate(angles)],
            sourceId=row['source_id'], sourcePiece=row['source_piece'], routeId=row['route_id'], networkId=row['network_id'],
            rule=row['rule'], review=row['review']))
    assert len(points) == len({p['id'] for p in points}) == 6563
    assert sum(len(p['slots']) for p in points) == 16572
    assert len({p['district'] for p in points}) == 16
    return dict(version=1, points=points)

if __name__ == '__main__':
    cli = argparse.ArgumentParser()
    cli.add_argument('source', type=Path)
    cli.add_argument('output', type=Path)
    args = cli.parse_args()
    catalog = build(args.source)
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(hashlib.sha256(args.source.read_bytes()).hexdigest(), len(catalog['points']), sum(len(p['slots']) for p in catalog['points']))
