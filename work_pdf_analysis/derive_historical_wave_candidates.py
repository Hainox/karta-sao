#!/usr/bin/env python3
"""Build a review-only historic-queue crosswalk for the current 97-wave ODH list.

Method: georeference the two cartographic sections of the supplied historical PDF
independently (main SAO + Molzhaninovsky inset), then sample only the red/blue/green
road strokes. This produces a candidate ledger; it never changes public map layers.
"""
from __future__ import annotations
import csv,json
from collections import defaultdict,Counter
from pathlib import Path
import cv2,numpy as np
from pyproj import Transformer

ROOT=Path(r'C:\Users\root\Downloads\КАРТА')
L=ROOT/'odh-map'/'layers'
DATA=ROOT/'projects'/'odh-yandex-export'/'data'
PDF=ROOT/'work_pdf_analysis'/'page_1.png'
OUT=DATA/'current_wave1_historical_pdf_review.csv'
MD=DATA/'current_wave1_historical_pdf_review.md'
J=DATA/'current_wave1_historical_pdf_review.json'
tr=Transformer.from_crs(4326,3857,always_xy=True)
im=cv2.imdecode(np.fromfile(PDF,dtype=np.uint8),cv2.IMREAD_COLOR)
hsv=cv2.cvtColor(im,cv2.COLOR_BGR2HSV)
# Hue/value bands measured from the three legend strokes and checked against map road strokes.
# Green mask deliberately excludes the pale green park fill.
def mask_range(lo,hi): return cv2.inRange(hsv,np.array(lo,np.uint8),np.array(hi,np.uint8))
red=mask_range((0,45,80),(10,255,248)) | mask_range((170,45,80),(179,255,248))
blue=mask_range((98,55,120),(108,255,235))
green=mask_range((65,45,120),(85,255,240))
# The legend/table is not part of either map section.
for m in (red,blue,green):
    m[:, :500]=0
    # Anti-aliasing and a small registration tolerance.
    m[:]=cv2.dilate(m,np.ones((5,5),np.uint8),iterations=1)
MASKS={'1':red>0,'2':blue>0,'3':green>0}

# PDF section boxes were checked against the SАО boundary silhouette. The inset is
# part of SАО; it is separate solely because of historical page layout.
MAIN=(37.4364835,55.7598459,37.5886333,55.9075674,525,355,1135,1630)
INSET=(37.3313205,55.9081959,37.4224581,55.9572896,118,32,612,525)
def to_pixel(lon,lat):
    x,y=tr.transform(lon,lat)
    # Molzhaninovsky inclusion rule: use its dedicated historical map inset.
    spec=INSET if (lon<37.426 and lat>55.907) else MAIN
    minlon,minlat,maxlon,maxlat,x0,y0,x1,y1=spec
    xmin,ymin=tr.transform(minlon,minlat);xmax,ymax=tr.transform(maxlon,maxlat)
    return x0+(x-xmin)/(xmax-xmin)*(x1-x0), y0+(ymax-y)/(ymax-ymin)*(y1-y0)

def ring_points(coords):
    # Existing road geometry is dense; every fourth vertex is adequate and avoids
    # giving unusually detailed polygons excess weight.
    return coords[::4] if len(coords)>4 else coords

def geometry_points(g):
    t=g.get('type');c=g.get('coordinates')
    if t=='Polygon':
        for ring in c:
            yield from ring_points(ring)
    elif t=='MultiPolygon':
        for poly in c:
            for ring in poly: yield from ring_points(ring)

def sample_geom(g):
    scores=Counter(); n=0
    for p in geometry_points(g):
        lon,lat=p[:2]; u,v=to_pixel(lon,lat); x,y=round(u),round(v)
        if not (2<=x<im.shape[1]-2 and 2<=y<im.shape[0]-2): continue
        n+=1
        for wave,mask in MASKS.items():
            if mask[y-2:y+3,x-2:x+3].any(): scores[wave]+=1
    return scores,n

wave=json.loads((L/'sao_wave1_complete_wgs84.geojson').read_text(encoding='utf-8'))
groups=defaultdict(lambda:{'name':'','fragments':0,'score':Counter(),'samples':0,'point_only':False})
for f in wave['features']:
    p=f.get('properties',{}); ident=str(p.get('id',''))
    if not ident: continue
    g=f.get('geometry',{})
    rec=groups[ident];rec['name']=p.get('name') or rec['name'];rec['fragments']+=1
    if g.get('type')=='Point':rec['point_only']=True;continue
    s,n=sample_geom(g);rec['score'].update(s);rec['samples']+=n

rows=[]
for ident,rec in sorted(groups.items(),key=lambda kv:(kv[1]['name'],kv[0])):
    raw={w:int(rec['score'][w]) for w in ('1','2','3')}
    total=sum(raw.values()); best=max(raw,key=raw.get); second=sorted(raw.values(),reverse=True)[1]
    coverage=(raw[best]/rec['samples']) if rec['samples'] else 0
    separation=((raw[best]-second)/raw[best]) if raw[best] else 0
    # Candidate only when there is actual historic line signal. Confidence combines
    # dominance with the proportion of the object's PDF trace carrying that colour.
    candidate=best if raw[best]>=3 and coverage>=.035 else ''
    confidence=round(separation*min(1,coverage/.18),2) if candidate else 0
    status=('нужна ручная сверка' if not candidate else
            'высокая уверенность' if confidence>=.70 else
            'средняя уверенность' if confidence>=.40 else 'низкая уверенность')
    method='историческая PDF-разметка; отдельная врезка Молжаниновского учитывается' if candidate else ('точечный/ориентировочный объект либо цвет линии не считан')
    rows.append({'id':ident,'name':rec['name'],'fragments':rec['fragments'],'old_queue_candidate':candidate,'confidence':confidence,'review_status':status,'pdf_samples':rec['samples'],'red_score':raw['1'],'blue_score':raw['2'],'green_score':raw['3'],'method_note':method})

fields=list(rows[0])
with OUT.open('w',newline='',encoding='utf-8-sig') as f:
    w=csv.DictWriter(f,fieldnames=fields,delimiter=';');w.writeheader();w.writerows(rows)
J.write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8')
by=defaultdict(list)
for r in rows:by[r['old_queue_candidate'] or 'не определено'].append(r)
labels={'1':'Историческая 1-я очередь (красная)','2':'Историческая 2-я очередь (синяя)','3':'Историческая 3-я очередь (зелёная)','не определено':'Не определено по PDF автоматически'}
lines=['# Проверочная ведомость: 97 текущих позиций 1-й очереди','', '**Статус:** черновая машинная сверка с историческим PDF. В публичную карту не внесена. Молжаниновский район включён в САО и обработан по отдельной врезке PDF.','']
for k in ['1','2','3','не определено']:
    lines += [f'## {labels[k]} — {len(by[k])}', '', '| ID | Наименование | Уверенность | Проверка |', '|---|---|---:|---|']
    for r in by[k]:lines.append(f"| {r['id']} | {r['name']} | {r['confidence']:.0%} | {r['review_status']} |")
    lines.append('')
MD.write_text('\n'.join(lines),encoding='utf-8')
print('records',len(rows),'groups',{k:len(v) for k,v in by.items()})
print('confidence',Counter(r['review_status'] for r in rows))
print('output',OUT)
