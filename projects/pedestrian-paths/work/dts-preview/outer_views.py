"""Расчёт внешнего обзора с протяжённых осей, в том числе между сетями АСУ."""
import hashlib
import math
from collections import defaultdict

from shapely import STRtree
from shapely.geometry import LineString, Point
from shapely.prepared import prep
from geometry import STEP, HALF_ANGLE, heading, sample_axis


def choose_hosts(rows):
    """Short through routes need observed continuations beyond both ends."""
    axes = [r['lines'][0] for r in rows]
    tree = STRtree(axes)
    hosts = set()
    for i,(r,axis) in enumerate(zip(rows,axes)):
        # Two or more nearby short surfaces form an observed local cluster.
        # A significantly longer, narrow carriage surface outside their convex
        # hull can carry a camera even if its own ASU line ends before 100 m.
        if axis.length>=35 and r['poly'].area/axis.length**2 < 0.15:
            small=[j for j in tree.query(axis,predicate='dwithin',distance=30)
                   if rows[j]['district']==r['district'] and axes[j].length<=min(30,axis.length/3)
                   and rows[j]['poly'].distance(r['poly'])>0.10]
            found=False
            for a,j in enumerate(small):
                for k in small[a+1:]:
                    if rows[j]['poly'].distance(rows[k]['poly'])>20:
                        continue
                    hull=rows[j]['poly'].union(rows[k]['poly']).convex_hull
                    if hull.distance(r['poly'])>0.10:
                        found=True
                        break
                if found:
                    break
            if found:
                hosts.add(r['rid'])
                continue
        if r['rule']=='compact':
            continue
        if axis.length >= STEP:
            hosts.add(r['rid'])
            continue
        if axis.length < 35:
            continue
        links = []
        for at in (0,axis.length):
            end = axis.interpolate(at)
            inward = axis.interpolate(5 if at==0 else axis.length-5)
            outgoing = heading(inward.coords[0],end.coords[0])
            near = set()
            for j in tree.query(end,predicate='dwithin',distance=4):
                if i==j or rows[j]['district']!=r['district'] or axes[j].length<35:
                    continue
                other=axes[j]
                s=other.project(end)
                for side in (-1,1):
                    extension=other.interpolate(max(0,min(other.length,s+side*15)))
                    if extension.distance(end)>=10 and abs((heading(end.coords[0],extension.coords[0])-outgoing+180)%360-180)<=45:
                        near.add(j)
            links.append(near)
        if any(a!=b for a in links[0] for b in links[1]):
            hosts.add(r['rid'])
    return hosts


def inner_routes(rows,hosts):
    """Positive evidence for an interior stub, independent of ASU network IDs."""
    axes=[r['lines'][0] for r in rows]
    tree=STRtree(axes)
    inner=set()
    for i,r in enumerate(rows):
        axis=axes[i]
        if r['rid'] in hosts or axis.length>35:
            continue
        nearby=[j for j in tree.query(axis,predicate='dwithin',distance=35)
                if i!=j and rows[j]['district']==r['district']]
        neighbours=[j for j in nearby if axes[j].length<=min(35,max(15,2*axis.length))
                    and 0.15<rows[j]['poly'].distance(r['poly'])<=15]
        carriers=[j for j in nearby if rows[j]['rid'] in hosts and axes[j].length>=3*axis.length
                  and rows[j]['poly'].distance(r['poly'])>0.10]
        center=r['poly'].representative_point()
        bearings=[heading(center.coords[0],axes[j].interpolate(axes[j].project(center)).coords[0]) for j in carriers]
        between=any(abs((a-b+180)%360-180)>=115 for n,a in enumerate(bearings) for b in bearings[n+1:])
        # Without a carrier require a cluster of at least three detached very
        # short stubs pointing in different directions before withholding its own camera.
        directions=[heading(axes[j].coords[0],axes[j].coords[-1])%180 for j in [i,*neighbours]
                    if axes[j].length<=15]
        mixed=len(directions)>=3 and any(abs((a-b+90)%180-90)>=35
                    for n,a in enumerate(directions) for b in directions[n+1:])
        if between or (neighbours and carriers) or (axis.length<=15 and mixed):
            inner.add(r['rid'])
    return inner


def allocate(rows, proposals, masks, walls):
    from build_preview import METRIC, WGS, GEOD, project
    hosts=choose_hosts(rows)
    inner=inner_routes(rows,hosts)
    aux=[r['poly'] for r in rows if r['rid'] in inner]
    interior=STRtree(aux)
    def allowed(pt):
        return not len(interior.query(pt,predicate='intersects'))
    by_id={r['rid']:r for r in rows}
    active=[]
    positions=[]
    angles=[]
    grid=defaultdict(list)
    obstacle_geoms=[g.buffer(0.001) for g in ([g for g,_,_ in masks]+walls)]
    obstacle_index=STRtree(obstacle_geoms)
    def register(p,pt):
        i=len(active)
        active.append(p)
        positions.append(pt)
        lng,lat,_=GEOD.fwd(*p['coordinates'],p['slots'][0]['azimuth'],10)
        angles.append(heading(pt.coords[0],METRIC.transform(lng,lat)))
        grid[(p['district'],math.floor(pt.x/STEP),math.floor(pt.y/STEP))].append(i)
    def nearby(district,pt,radius):
        x,y=pt.coords[0]
        for i in range(math.floor((x-radius)/STEP),math.floor((x+radius)/STEP)+1):
            for j in range(math.floor((y-radius)/STEP),math.floor((y+radius)/STEP)+1):
                yield from grid.get((district,i,j),())
    for p in proposals:
        r=by_id[p['routeId']]
        pt=project(Point(p['coordinates']),METRIC)
        if p['routeId'] not in inner and allowed(pt):
            register(p,pt)
    host_rows=[r for r in rows if r['rid'] in hosts]
    trunks=[r['lines'][0] for r in host_rows]
    tree=STRtree(trunks)
    records=[]
    for seq,r in enumerate(rows):
        if seq%500==0:
            print('Внешний обзор',seq,'из',len(rows),flush=True)
        targets=sample_axis(r['lines'],r['poly'],r['rule'])
        sids=r['sids']
        rid=r['rid']
        district=r['district']
        is_host=rid not in inner
        possible=sorted(tree.query(r['poly'],predicate='dwithin',distance=STEP),
                        key=lambda j:(r['poly'].distance(trunks[j]),host_rows[j]['rid']))
        possible=[j for j in possible if host_rows[j]['district']==district]
        if not is_host:
            possible=[j for j in possible if trunks[j].length>=1.25*r['lines'][0].length]
        else:
            possible=[j for j in possible if host_rows[j]['rid']==rid]
        available_hosts={rid} if is_host else {host_rows[j]['rid'] for j in possible}
        obstacles=[prep(obstacle_geoms[j]) for j in obstacle_index.query(r['poly'].envelope.buffer(STEP))]
        def rays(pt,indices):
            xy=pt.coords[0]
            res=[]
            for k in indices:
                dest=targets[k]
                dist=math.dist(xy,dest)
                if dist>STEP+1e-7:
                    continue
                if dist<0.002:
                    res.append((k,None))
                else:
                    line=LineString([xy,dest])
                    if not any(o.intersects(line) for o in obstacles):
                        res.append((k,heading(xy,dest)))
            return res
        def in_frame(visible,angle):
            return {k for k,a in visible if a is None or abs((a-angle+180)%360-180)<=HALF_ANGLE+1e-7}
        center=r['poly'].centroid
        radius=STEP+math.hypot(r['poly'].bounds[2]-r['poly'].bounds[0],r['poly'].bounds[3]-r['poly'].bounds[1])
        missing=set(range(len(targets)))
        evidence={}
        for i in nearby(district,center,radius):
            if active[i]['routeId'] not in available_hosts:
                continue
            if not is_host and by_id[active[i]['routeId']]['lines'][0].distance(positions[i])>0.005:
                continue
            hits=in_frame(rays(positions[i],missing),angles[i])
            if hits:
                evidence[active[i]['id']]=sorted(hits)
                missing-=hits
            if not missing:
                break
        # New inward frames are restricted to the larger carrier's trunk.
        # Samples on spurs and islands are targets only.
        if missing and possible:
            candidates=[]
            for j in possible[:5]:
                axis=trunks[j]
                probes=[targets[k] for k in sorted(missing)]
                if len(probes)>12:
                    probes=[probes[round(k*(len(probes)-1)/11)] for k in range(12)]
                chainages={min(axis.length,max(0,axis.project(Point(t))+delta))
                           for t in probes for delta in (-12,0,12)}
                for s in sorted(chainages):
                    pt=axis.interpolate(s)
                    if not host_rows[j]['poly'].contains(pt) or not allowed(pt):
                        continue
                    if any(positions[i].distance(pt)<3 for i in nearby(district,pt,3)):
                        continue
                    seen=rays(pt,missing)
                    if not seen:
                        continue
                    for angle in sorted({(a+offset)%360 for _,a in seen if a is not None for offset in (0,HALF_ANGLE-0.02)}):
                        rad=math.radians(angle)
                        xy=pt.coords[0]
                        geo=tuple(round(v,9) for v in WGS.transform(*xy))
                        target=WGS.transform(xy[0]+math.sin(rad),xy[1]+math.cos(rad))
                        azi=round(GEOD.inv(*geo,*target)[0]%360,3)%360
                        point=project(Point(geo),METRIC)
                        lng,lat,_=GEOD.fwd(*geo,azi,10)
                        actual=heading(point.coords[0],METRIC.transform(lng,lat))
                        hits=in_frame(seen,actual)
                        if hits:
                            candidates.append((hits,point,azi,geo,j,s))
            while missing and candidates:
                hits,pt,azi,geo,j,s=max(candidates,key=lambda c:len(c[0]&missing))
                hits=hits&missing
                if not hits:
                    break
                # Recheck with the rounded coordinates stored in the catalog.
                lng,lat,_=GEOD.fwd(*geo,azi,10)
                hits=in_frame(rays(pt,hits),heading(pt.coords[0],METRIC.transform(lng,lat)))
                candidates=[c for c in candidates if c[1].distance(pt)>=3]
                if not hits or not allowed(pt):
                    continue
                host=host_rows[j]
                sid=min(host['related'],key=lambda v:v[1].distance(pt))[0]
                key=hashlib.sha256(f"{host['rid']}|{geo}|{azi}".encode()).hexdigest()[:16]
                pid='ДТС-'+key
                p=dict(id=pid,district=district,balance=district,street=sid,sourceId=sid,
                       taskId=host['rid'],sourcePiece=sid,routeId=host['rid'],networkId=host['network'],
                       coordinates=list(geo),slots=[dict(id='ДТС-кадр-'+key,azimuth=azi)],rule=host['rule'],
                       station_m=None,main_projection_m=round(s,2) if host['rule']=='long' else None,
                       unique_samples=len(hits),perimeter=False,review='Проверить обзор с основной дорожки на месте')
                register(p,pt)
                evidence[pid]=sorted(hits)
                missing-=hits
        records.append(dict(routeId=rid,district=district,sourceIds=sids,mode='main' if is_host else 'external',
            samples=len(targets),covered=len(targets)-len(missing),
            status='covered' if not missing else 'partial' if evidence else 'review',
            pointIds=list(evidence),sampleIndicesByPoint=evidence,missingSamples=sorted(missing),
            sampleCoordinates=[list(WGS.transform(*p)) for p in targets]))
    owners={p['id']:p for p in active}
    for p in active:
        p['coveredRouteIds']=[]
    for item in records:
        item['hostRouteIds']=sorted({owners[k]['routeId'] for k in item['pointIds']})
        for k in item['pointIds']:
            owners[k]['coveredRouteIds'].append(item['routeId'])
    return active,records
