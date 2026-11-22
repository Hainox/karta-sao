"""Независимая сверка сериализованных результатов и связей со снимком."""
from collections import Counter, defaultdict
import csv
import json
import math

from shapely import STRtree, union_all
from shapely.geometry import LineString, Point, shape
from build_preview import GEOD, HERE, ROOT, METRIC, read, write, polygon, project, load_masks, buildings


def duplicates(points):
    positions=[project(Point(p['coordinates']),METRIC) for p in points]
    tree=STRtree(positions)
    rows=[]
    for i,p in enumerate(points):
        for j in tree.query(positions[i],predicate='dwithin',distance=5):
            if i>=j:
                continue
            q=points[j]
            difference=min(abs((a['azimuth']-b['azimuth']+180)%360-180) for a in p['slots'] for b in q['slots'])
            if difference<=10:
                rows.append(dict(a=p['id'],b=q['id'],district=p['district'],distance_m=round(positions[i].distance(positions[j]),2),
                    difference_deg=round(difference,2),same_route=p['routeId']==q['routeId']))
    return rows


def audit():
    data=HERE/'data'
    old=read(HERE/'original-api.json')['points']
    new=read(data/'catalog.json')['points']
    metrics=read(data/'summary.json')
    ids={p['id'] for p in new}
    slots={s['id'] for p in new for s in p['slots']}
    assert len(new)==len(ids)==len(slots)
    assert all(len(p['slots'])==1 and 0<=p['slots'][0]['azimuth']<360 for p in new)
    assert len({tuple(p['coordinates']) for p in new})==len(new), 'Совпадающие точки'
    cuts=read(data/'excluded.geojson')['features']
    cuts_geom=[project(shape(f['geometry']),METRIC) for f in cuts]
    cut_index=STRtree(cuts_geom)
    masks,mask_tree=load_masks(HERE/'parks-osm.geojson')
    walls,wall_tree=buildings()
    by_sid={p['sourceId'] for p in old}
    paths={str(f['id']):polygon(f) for name in (ROOT/'districts/layers').glob('*/paths.geojson')
           for f in read(name)['features'] if str(f['id']) in by_sid}
    districts={f['properties']['district']:polygon(f) for f in read(ROOT/'districts.geojson')['features']}
    mask_geometries = [m[0] for m in masks]
    for p in new:
        xy=project(Point(p['coordinates']),METRIC)
        assert xy.distance(paths[p['sourceId']]) < 0.001, p['id']
        assert xy.distance(districts[p['district']]) < 0.001, p['id']
        for geometries,tree in [(cuts_geom,cut_index),(mask_geometries,mask_tree),(walls,wall_tree)]:
            for i in tree.query(xy,predicate='intersects'):
                if geometries[i].geom_type not in ('Polygon','MultiPolygon'):
                    continue
                assert xy.distance(geometries[i].boundary)<0.001,(p['id'],i)
    sources={p['id']:p for p in old}
    proposed={p['id']:p for p in new}
    dispositions=read(data/'dispositions.json')
    assert {d['pointId'] for d in dispositions}==set(sources)
    pairs={name:duplicates(points) for name,points in [('before',old),('after',new)]}
    for pair in pairs['after']:
        a,b=proposed[pair['a']],proposed[pair['b']]
        pair.update(a_route=a['routeId'],b_route=b['routeId'],unique_samples_a=a['unique_samples'],unique_samples_b=b['unique_samples'],note='Проверить, можно ли снять оба обзора из одной позиции на месте')
    write(data/'similar-views.json',pairs)
    old_pairs=defaultdict(set)
    for r in pairs['before']:
        old_pairs[r['a']].add(r['b'])
        old_pairs[r['b']].add(r['a'])
    for row in dispositions:
        p=sources[row['pointId']]
        g=project(Point(p['coordinates']),METRIC)
        row['oldOnSource']=paths[p['sourceId']].covers(g) if p['sourceId'] in paths else None
        row['oldSimilarPoints']=sorted(old_pairs[p['id']])
        q=proposed.get(p['id'])
        if q:
            row['newSlotId']=q['slots'][0]['id']
            row['newCoordinates']=q['coordinates']
            row['moved_m']=round(g.distance(project(Point(q['coordinates']),METRIC)),2)
            row['nearestOldAngleDifference_deg']=round(min(abs((q['slots'][0]['azimuth']-s['azimuth']+180)%360-180) for s in p['slots']),2)
    write(data/'dispositions.json',dispositions)
    route_rows=read(data/'routes.geojson')['features']
    evidence=read(data/'external-coverage.json')
    mapped={r['properties']['routeId']:r for r in route_rows}
    assert len(evidence)==len(mapped)==len(route_rows)
    by_rid={r['routeId']:r for r in evidence}
    assert set(by_rid)==set(mapped)
    projected={pid:project(Point(p['coordinates']),METRIC) for pid,p in proposed.items()}
    from geometry import heading
    bearings={}
    expected_links=defaultdict(set)
    obstacle_geoms=mask_geometries+walls
    obstacle_tree=STRtree(obstacle_geoms)
    for pid,p in proposed.items():
        assert by_rid[p['routeId']]['mode']=='main'
        lng,lat,_=GEOD.fwd(*p['coordinates'],p['slots'][0]['azimuth'],10)
        bearings[pid]=heading(projected[pid].coords[0],METRIC.transform(lng,lat))
    for record in evidence:
        pts=record['sampleCoordinates']
        missing=set(record['missingSamples'])
        seen=set()
        assert len(pts)==record['samples'] and len(missing)+record['covered']==len(pts)
        assert set(record['pointIds'])==set(record['sampleIndicesByPoint'])
        for pid,indices in record['sampleIndicesByPoint'].items():
            expected_links[pid].add(record['routeId'])
            p=proposed[pid]
            assert p['district']==record['district']
            if record['mode']=='external':
                assert p['routeId']!=record['routeId']
                assert mapped[p['routeId']]['properties']['length_m']+0.02>=1.25*mapped[record['routeId']]['properties']['length_m']
            for k in indices:
                assert k not in seen and 0<=k<len(pts)
                seen.add(k)
                dest=METRIC.transform(*pts[k])
                origin=projected[pid].coords[0]
                dist=math.dist(origin,dest)
                assert dist<=100.001
                if dist<0.002:
                    continue
                assert abs((heading(origin,dest)-bearings[pid]+180)%360-180)<=35.00001
                assert not len(obstacle_tree.query(LineString([origin,dest]),predicate='intersects'))
        assert seen==set(range(len(pts)))-missing
        assert record['status']==('covered' if not missing else 'partial' if seen else 'review')
        assert set(record['hostRouteIds'])=={proposed[pid]['routeId'] for pid in record['pointIds']}
    for pid,p in proposed.items():
        assert set(p['coveredRouteIds'])==expected_links[pid]
    sports=next(row for row in cuts if row['properties']['sourceId']=='131608367800030'
                and row['properties']['maskId']=='131608340200027' and row['properties']['scope']=='full')
    assert not any('131608367800030' in row['sourceIds'] for row in evidence)
    by_route=defaultdict(list)
    for p in new:
        by_route[p['routeId']].append(p)
    gaps=[]
    for f in route_rows:
        r=f['properties']
        if r['rule']=='long':
            points=by_route[r['routeId']]
            stations=sorted(p['station_m'] for p in points if p['station_m'] is not None)
            values=[round(b-a,2) for a,b in zip(stations,stations[1:])]
            assert all(d<=100.01 for d in values),(r,stations)
            projected=sorted(p['main_projection_m'] for p in points)
            full_gaps=[round(b-a,2) for a,b in zip([0,*projected],[*projected,r['length_m']])]
            explanation = ('Часть направлений выбрана по обзору после проверки препятствий и изгибов' if len(points)>len(stations) else 'Регулярные станции до последнего неполного участка')
            gaps.append(dict(all_positions_m=projected,all_gaps_with_ends_m=full_gaps,max_m=max(full_gaps),reason=explanation,routeId=r['routeId'],district=r['district'],sourceIds=r['sourceIds'],
                length_m=r['length_m'],stations_m=stations,gaps_m=values,other_positions=len(points)-len(stations),
                tail_m=full_gaps[-1]))
    write(data/'chainage.json',gaps)
    max_step=max(r['max_m'] for r in gaps)
    assert max_step <= 100.02, max_step
    metrics['longest_gap_m']=max_step
    per_source=defaultdict(list)
    for f,geom in zip(cuts,cuts_geom):
        p=f['properties']
        if p['scope'] != 'point':
            per_source[p['sourceId']].append((p,geom))
    extents=[]
    for sid,segments in sorted(per_source.items()):
        p=segments[0][0]
        clipped=union_all([g for _,g in segments])
        remainder=paths[sid].difference(clipped).area
        extents.append(dict(sourceId=sid,district=p['district'],reasons=sorted({q['kind'] for q,_ in segments}),
            original_area_m2=round(paths[sid].area,3),excluded_area_m2=round(paths[sid].intersection(clipped).area,3),
            remaining_area_m2=round(remainder,3),scope='full' if remainder<0.001 else 'partial'))
    write(data/'excluded-sources.json',extents)
    for name in ('full','partial'):
        rows=[item for item in extents if item['scope']==name]
        metrics['total']['excluded_sources_'+name]=len(rows)
        for district,row in metrics['districts'].items():
            row['excluded_sources_'+name]=sum(item['district']==district for item in rows)
    for when,rows in pairs.items():
        for q in metrics['districts'].values():
            q['similar_'+when]=0
        for p in rows:
            metrics['districts'][p['district']]['similar_'+when]+=1
        metrics['total']['similar_'+when]=len(rows)
    for row in [*metrics['districts'].values(),metrics['total']]:
        row['long_points_per_km']=round(1000*row.get('long_points',0)/row['long_m'],2) if row.get('long_m') else None
    write(data/'summary.json',metrics)
    keys=sorted({k for row in metrics['districts'].values() for k in row})
    with (data/'districts.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.writer(f,delimiter=';')
        writer.writerow(['Район',*keys])
        for name,row in sorted(metrics['districts'].items()):
            writer.writerow([name,*[row.get(k,0) for k in keys]])
    print(json.dumps(metrics['total'],ensure_ascii=False))


if __name__=='__main__':
    audit()
