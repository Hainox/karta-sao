"""Сборка только локального проекта ДТС из неизменяемого снимка районного API."""
import argparse
from collections import Counter, defaultdict
import csv
import hashlib
import json
import math
from pathlib import Path

from pyproj import Geod, Transformer
from shapely import STRtree, make_valid, transform, union_all
from shapely.geometry import LineString, Point, Polygon, mapping, shape
from shapely.errors import GEOSException
from geometry import clip_contact, parts, plan, sports_cut
from outer_views import allocate

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
METRIC = Transformer.from_crs(4326, 32637, always_xy=True)
WGS = Transformer.from_crs(32637, 4326, always_xy=True)
GEOD = Geod(ellps='WGS84')
LABEL = {'park':'парк', 'dp':'детская площадка', 'sp':'спортивная площадка'}
METHOD = {'long':'шаг по осевой с поправкой на изгиб', 'short':'обзор вдоль короткого прохода',
          'branched':'совместный обзор ветвей', 'compact':'обзор внутрь с периметра'}


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write(path, value):
    temp = path.with_suffix(path.suffix+'.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, separators=(',',':')), encoding='utf-8')
    temp.replace(path)


def project(g, crs):
    return transform(g, crs.transform, interleaved=False)


def polygon(feature):
    g = project(shape(feature['geometry']), METRIC)
    return union_all(parts(make_valid(g), 'Polygon'))


def feature(g, **props):
    return dict(type='Feature', geometry=mapping(project(g,WGS)), properties=props)


def fc(features):
    return dict(type='FeatureCollection', features=features)


def load_masks(park_file):
    rows = [(polygon(f), 'park', str(f['properties']['id'])) for f in read(park_file)['features']]
    for kind in ('dp','sp'):
        for name in sorted((ROOT/'districts/layers').glob(f'*/{kind}.geojson')):
            for f in read(name)['features']:
                g = polygon(f)
                if not g.is_empty:
                    rows.append((g, kind, str(f['id'])))
    return rows, STRtree([r[0] for r in rows])


def buildings():
    walls = {}
    for name in sorted((ROOT/'projects/sidewalk-photo-points/work').glob('osm_buildings_*.json')):
        for el in read(name)['elements']:
            ring = el.get('geometry', [])
            if 'building' not in el.get('tags',{}) or len(ring)<4 or ring[0]!=ring[-1]:
                continue
            key = (el['type'],el['id'])
            if key not in walls:
                g = Polygon([(p['lon'],p['lat']) for p in ring])
                walls[key] = project(make_valid(g),METRIC)
    data = list(walls.values())
    return data, STRtree(data)


def build(snapshot, parks, out):
    out.mkdir(parents=True, exist_ok=True)
    old = read(snapshot)['points']
    if len({p['id'] for p in old}) != len(old):
        raise ValueError('Повтор ID в исходном каталоге')
    if any(s.get('photoId') or s.get('status') != 'empty' for p in old for s in p['slots']):
        raise ValueError('Снимок содержит фотографии; требуется индивидуальная привязка кадров')
    old_by_source, coords = defaultdict(list), {}
    stats = defaultdict(Counter)
    for p in old:
        sid = str(p['sourceId'])
        old_by_source[sid].append(p)
        coords[p['id']] = project(Point(p['coordinates']),METRIC)
        row = stats[p['district']]
        row['old_points'] += 1
        row['old_slots'] += len(p['slots'])
        row['old_multislot'] += len(p['slots'])>1
    masks, mask_index = load_masks(parks)
    walls, wall_index = buildings()
    districts = {f["properties"]["district"]:polygon(f) for f in read(ROOT/"districts.geojson")["features"]}
    paths = {}
    for name in sorted((ROOT/'districts/layers').glob('*/paths.geojson')):
        for f in read(name)['features']:
            sid = str(f['id'])
            if sid in old_by_source:
                paths[sid] = polygon(f)
    print('Контуры найдены',len(paths),'из',len(old_by_source),flush=True)
    groups, allowed_by_source = defaultdict(list), {}
    excluded, review, routes, proposals = [], [], [], []
    states, reason_ids, uncertain_ids = {}, defaultdict(set), defaultdict(set)
    confirmed_cuts = []
    route_model = []
    collars = []
    def mark(g, sid, district, reason):
        review.append(feature(g,sourceId=sid,district=district,reason=reason))
        uncertain_ids[district].add(sid)
    for sid, originals in sorted(old_by_source.items()):
        district = originals[0]['district']
        path = paths.get(sid)
        if path is None:
            for p in originals:
                g = coords[p['id']]
                hits = mask_index.query(g,predicate='intersects')
                kinds = sorted({masks[i][1] for i in hits})
                if kinds:
                    for i in hits:
                        _,kind,mid = masks[i]
                        excluded.append(feature(g,sourceId=sid,district=district,kind=kind,maskId=mid,
                            scope='point',reason='Исходная точка в контуре: '+LABEL[kind]))
                    states[p['id']] = 'excluded_mask'
                else:
                    states[p['id']] = 'review'
                mark(g,sid,district,'Контур исходной дорожки отсутствует; границы участка неизвестны')
            continue
        width = 2*path.area/path.length
        cuts = []
        for idx in sorted(mask_index.query(path,predicate='dwithin',distance=max(0.03,width))):
            mask, kind, mid = masks[idx]
            if not path.intersects(mask):
                if kind in ('dp','sp'):
                    mark(path,sid,district,f'Зазор до контура {mid} ({LABEL[kind]}): '+
                         f'{path.distance(mask):.2f} м, меньше расчётной ширины дорожки {width:.2f} м')
                continue
            ring = False
            if kind == 'park':
                cut = path.intersection(mask)
                ambiguous = cut.area == 0
            elif kind == 'sp':
                cut, ambiguous, ring = sports_cut(path,mask)
                if ring:
                    collars.append((sid,cut,mid,district))
            else:
                cut, ambiguous = clip_contact(path,mask)
            if ambiguous:
                mark(path,sid,district,'Точечное касание контура '+mid+' ('+LABEL[kind]+')')
            if cut.area > 1e-8:
                cuts.append(cut)
                confirmed_cuts.append((sid,cut,kind,mid))
                reason_ids[(district,kind)].add(sid)
                excluded.append(feature(cut,sourceId=sid,district=district,kind=kind,maskId=mid,
                    reason='Замкнутый периметр СП и прилегающая входная часть' if ring else 'Пересечение контура' if kind=='park' else 'Перекрытие или общая граница ДТС и площадки',
                    scope='full' if path.difference(cut).area<1e-8 else 'partial'))
        left = path.difference(union_all(cuts)) if cuts else path
        # Protect against both through-building cameras and through-building rays.
        ids = wall_index.query(left,predicate='intersects')
        if len(ids):
            inside = left.intersection(union_all([walls[i] for i in ids]))
            if inside.area>1e-6:
                mark(inside,sid,district,'Пересечение с контуром здания OSM; требуется сверка')
                left = left.difference(inside)
        beyond = left.difference(districts[district])
        if beyond.area > 1e-6:
            mark(beyond,sid,district,'За границей закреплённого района; проверить принадлежность')
            left = left.intersection(districts[district])
        allowed_by_source[sid] = left
        for seq,part in enumerate(parts(left,'Polygon')):
            if part.area < 1 or 2*part.area/part.length < 0.35:
                mark(part,sid,district,'Малый или узкий фрагмент: безопасная позиция не подтверждена')
                continue
            original = min(originals,key=lambda p:part.distance(coords[p['id']]))
            groups[(district,original['networkId'])].append((sid,part))
        for p in originals:
            g = coords[p['id']]
            if any(g.intersects(c) for c in cuts):
                states[p['id']] = 'excluded_mask'
            elif not path.covers(g):
                mark(g,sid,district,'Исходная позиция вне контура своего объекта')
    # Two ASU records can cover the same pavement. Propagate spatially verified
    # cuts across overlapping sources before generating any stations.
    # Separate dead-end access pieces may have a different ASU network ID.
    # Require physical contact, a short confined extent and no through connection.
    path_ids=list(paths)
    all_paths=[paths[k] for k in path_ids]
    path_tree=STRtree(all_paths)
    for owner,collar,mid,district in collars:
        for k in path_tree.query(collar,predicate='dwithin',distance=0.05):
            sid=path_ids[k]
            g=all_paths[k]
            if sid==owner or old_by_source[sid][0]['district']!=district:
                continue
            if not collar.buffer(8).covers(g) or g.length>45 or g.area>40:
                continue
            others=[all_paths[j] for j in path_tree.query(g,predicate='dwithin',distance=0.10)
                    if path_ids[j] not in (owner,sid) and not collar.buffer(0.1).covers(all_paths[j])]
            if others:
                mark(g,sid,district,'Короткое примыкание у периметра СП '+mid+' имеет другие связи; проверить на месте')
                continue
            confirmed_cuts.append((owner,g,'sp',mid))
    cut_tree = STRtree([r[1] for r in confirmed_cuts])
    for group, rows in groups.items():
        clipped = []
        for sid,part in rows:
            ids = cut_tree.query(part,predicate='intersects')
            extra = []
            for i in ids:
                owner,mask,kind,mid = confirmed_cuts[i]
                if sid==owner:
                    continue
                overlap=part.intersection(mask)
                if overlap.area <= 1e-6:
                    continue
                extra.append(mask)
                reason_ids[(group[0],kind)].add(sid)
                excluded.append(feature(overlap,sourceId=sid,district=group[0],kind=kind,maskId=mid,scope='partial',reason='Совпадение с исключённой частью смежной записи ДТС'))
                for p in old_by_source[sid]:
                    if mask.covers(coords[p['id']]):
                        states[p['id']]='excluded_mask'
            remaining = part.difference(union_all(extra)) if extra else part
            for geom in parts(remaining,'Polygon'):
                if geom.area >= 1 and 2*geom.area/geom.length >= 0.35:
                    clipped.append((sid,geom))
                else:
                    mark(geom,sid,group[0],'Малый фрагмент после наложения исключений')
        groups[group]=clipped
    assigned = {}
    examples = {}
    for n,((district,network),rows) in enumerate(sorted(groups.items())):
        if n%500 == 0:
            print('Сетей обработано',n,'из',len(groups),flush=True)
        polygons = sorted(parts(union_all([g for _,g in rows]),'Polygon'),key=lambda g:(g.bounds,g.area))
        for seq,poly in enumerate(polygons,1):
            related = [(s,g) for s,g in rows if poly.intersects(g) and poly.intersection(g).area > 0]
            sids = sorted({s for s,_ in related})
            if not sids:
                continue
            try:
                bbox = poly.envelope
                blockers = [walls[i] for i in wall_index.query(bbox,predicate='intersects')]
                blockers.extend(masks[i][0] for i in mask_index.query(bbox,predicate='intersects'))
                prior = []
                for sid in sids:
                    for p in old_by_source[sid]:
                        origin = coords[p['id']]
                        if not poly.contains(origin):
                            continue
                        angles = []
                        for slot in p['slots']:
                            lng,lat,_ = GEOD.fwd(*p['coordinates'],slot['azimuth'],1.0)
                            x,y = METRIC.transform(lng,lat)
                            angles.append(math.degrees(math.atan2(x-origin.x,y-origin.y))%360)
                        prior.append((origin.coords[0],angles))
                lines, views, counts, rule = plan(poly, union_all(blockers), prior)
            except GEOSException as exc:
                mark(poly,sids[0],district,'Невозможно восстановить ось: '+str(exc))
                continue
            rid = network+'-ДТС-'+str(seq)
            if not lines:
                mark(poly,sids[0],district,'Не восстановлена ось участка')
                continue
            route_model.append(dict(rid=rid, district=district, network=network, sids=sids, related=related, poly=poly, lines=lines, rule=rule))
            sample_count, observed = counts['samples'],counts['covered']
            row = stats[district]
            row['samples'] += sample_count
            row['covered_samples'] += observed
            row['old_samples_same_routes'] += counts['old_covered']
            if rule=='compact':
                row['compact_points'] += len(views)
                row['compact_perimeter_points'] += sum(v['perimeter'] for v in views)
            row['routes'] += 1
            if rule=='long':
                row['long_m'] += lines[0].length
                row['long_points'] += len(views)
            row['rule_'+rule] += 1
            if rule not in examples or (rule=='long' and len(views)>=3 and all(v['station'] is not None for v in views)):
                examples[rule]=rid
            routes.append(feature(union_all(lines),sourceId=sids[0],sourceIds=sids,district=district,
                routeId=rid,networkId=network,rule=rule,reason=METHOD[rule],length_m=round(lines[0].length,2),
                samples=sample_count,covered=observed,old_covered=counts['old_covered'],area_m2=round(poly.area,2)))
            for j,view in enumerate(views,1):
                pt=Point(view['xy'])
                sid=min(related,key=lambda r:r[1].distance(pt))[0]
                geo=project(pt,WGS).coords[0]
                aim=project(Point(view['aim']),WGS).coords[0]
                azi=round(GEOD.inv(*geo,*aim)[0]%360,3)%360
                potentials=[p for p in old_by_source[sid] if p['id'] not in assigned and p['id'] not in states and poly.covers(coords[p['id']])]
                old_pt=min(potentials,key=lambda p:pt.distance(coords[p['id']])) if potentials else None
                # Long moves must not repurpose an unrelated point as a false match.
                if old_pt and pt.distance(coords[old_pt['id']]) > 100:
                    old_pt=None
                pos=[round(x,9) for x in geo]
                key = hashlib.sha256(f'{rid}|{sid}|{pos}|{azi}'.encode()).hexdigest()[:16]
                pid = old_pt['id'] if old_pt else 'ДТС-'+key
                slot_id='ДТС-кадр-'+key
                if old_pt:
                    assigned[pid]=rid
                    states[pid]='moved' if pt.distance(coords[pid])>0.001 else 'retained'
                    if states[pid]=='retained':
                        pos=old_pt['coordinates']
                    original_slot=next((s for s in old_pt['slots'] if abs((s['azimuth']-azi+180)%360-180)<0.001),None)
                    if states[pid]=='retained' and original_slot:
                        slot_id=original_slot['id']
                        pos,azi=old_pt['coordinates'],original_slot['azimuth']
                row['new_points'] += 1
                row['created'] += not old_pt
                proposals.append(dict(id=pid,district=district,balance=district,street=sid,sourceId=sid,
                    taskId=rid,sourcePiece=(old_pt['sourcePiece'] if old_pt else sid),routeId=rid,networkId=network,
                    coordinates=pos,slots=[dict(id=slot_id,azimuth=azi)],rule=rule,
                    station_m=round(view['station'],2) if view['station'] is not None else None,
                    unique_samples=view['unique_samples'],perimeter=view['perimeter'],
                    main_projection_m=round(lines[0].project(pt),2) if rule=='long' else None,
                    review='Предварительный обзор; проверить доступность и видимость на месте'))
    proposals, coverage = allocate(route_model, proposals, masks, walls)
    write(out/'external-coverage.json',coverage)
    keep={p['id'] for p in proposals}
    for pid in list(assigned):
        if pid not in keep:
            del assigned[pid]
            del states[pid]
    for row in stats.values():
        for key in ('new_points','created','long_points','compact_points','compact_perimeter_points','covered_samples'):
            row[key]=0
    for p in proposals:
        row=stats[p['district']]
        row['new_points']+=1
        row['created']+=p['id'] not in assigned
        row['long_points']+=p['rule']=='long'
    planned_sources=set()
    unresolved_sources=set()
    for f,record,model in zip(routes,coverage,route_model,strict=True):
        assert f['properties']['routeId']==record['routeId']
        f['properties'].update({k:v for k,v in record.items() if k not in ('sampleCoordinates','sampleIndicesByPoint')})
        row=stats[record['district']]
        row['covered_samples']+=record['covered']
        row[record['mode']+'_routes_'+record['status']]+=1
        if record['missingSamples']:
            reason='Часть контрольных целей без подтверждённого обзора' if record['covered'] else 'Нет подтверждённой позиции для съёмки'
            if record['mode']=='external':
                reason+=' с внешней крупной дорожки'
            review.append(feature(model['poly'],district=model['district'],sourceId=model['sids'][0],
                                  sourceIds=model['sids'],routeId=model['rid'],reason=reason))
            uncertain_ids[model['district']].update(model['sids'])
            unresolved_sources.update(model['sids'])
        if record['covered']:
            planned_sources.update(model['sids'])
    planned_sources-=unresolved_sources
    dispositions = []
    for p in old:
        sid=p['sourceId']
        state=states.get(p['id'], 'superseded' if sid in planned_sources else 'review')
        stats[p['district']][state]+=1
        dispositions.append(dict(pointId=p['id'],district=p['district'],sourceId=sid,status=state,
            oldCoordinates=p['coordinates'],oldSlots=p['slots'],newPointId=p['id'] if p['id'] in assigned else None))
    for (district,kind),ids in reason_ids.items():
        stats[district]['paths_'+kind]=len(ids)
    for district,ids in uncertain_ids.items():
        stats[district]['ambiguous_sources']=len(ids)
    for district,row in stats.items():
        row['new_slots']=row['new_points']
        row['removed']=row['old_points']-row['moved']-row['retained']
    total = sum(stats.values(),Counter())
    metrics = dict(total=total,districts=stats,examples=examples,
        original_sha256=hashlib.sha256(snapshot.read_bytes()).hexdigest(),parks_sha256=hashlib.sha256(parks.read_bytes()).hexdigest(),
        source_ids=len(old_by_source),matched_source_ids=len(paths),sample_spacing_m=10,horizontal_fov_deg=70)
    write(out/'catalog.json',dict(version=1,singleFrame=True,points=proposals))
    for name,features in [('excluded',excluded),('review',review),('routes',routes)]:
        write(out/(name+'.geojson'),fc(features))
    write(out/'dispositions.json',dispositions)
    write(out/'summary.json',metrics)
    keys=sorted({key for s in stats.values() for key in s})
    with (out/'districts.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer=csv.writer(f,delimiter=';')
        writer.writerow(['Район',*keys])
        for district,row in sorted(stats.items()):
            writer.writerow([district,*[row[k] for k in keys]])
    print('Итог',json.dumps(total,ensure_ascii=False))


if __name__=='__main__':
    cli=argparse.ArgumentParser()
    cli.add_argument('--original',type=Path,default=HERE/'original-api.json')
    cli.add_argument('--parks',type=Path,default=HERE/'parks-osm.geojson')
    args=cli.parse_args()
    build(args.original,args.parks,HERE/'data')

