#!/usr/bin/env python3
"""Finalize owner-approved 3-queue cascade and build non-public staging GeoJSON layers."""
from __future__ import annotations
import csv,json
from collections import Counter
from pathlib import Path
ROOT=Path(r'C:\Users\root\Downloads\КАРТА')
DATA=ROOT/'projects'/'odh-yandex-export'/'data'
LAYERS=ROOT/'odh-map'/'layers'
STAGE=ROOT/'projects'/'odh-yandex-export'/'outputs'
STAGE.mkdir(exist_ok=True)
# Where source-list wording is abbreviated or points to a specific address segment,
# resolve it once to the corresponding registry ID. These are checked against the
# real registry names in the audit artefact and keep the 56/46/489 owner totals.
OVERRIDES={
 'Лобненская ул.':'10002320',
 'ул. Лавочкина (Ховрино)':'309891302',
 'Проезд вдоль Ленинградского ш. (Колпинская)':'10002475',
 'ул. 800-летия Москвы':'10002353',
 'переулок 800-летия Москвы':'10002494',
 'Краснополянская вл.10 (пр. к Мясопрому)':'754379044',
 'Проезд Михалковская—3-й Новомихалк.':'10002527',
 'Проезд Петрозаводская—Зеленоградская':'10002534',
 'Проезд Дегунинская—Коровинское ш.':'12344970',
 'Проезды Ленинградская—1-я Сестрорецкая':'10002509',
 'Авиаконструктора Микояна 14 (у Ходынки/ЦСКА)':'12344853',
 'Ленинградское ш. д.362А':'1095555469',
 'Проезд от Нарвской до Водного стадиона':'10002530',
 'Проезд Ленинградское ш.—3-я Сестрорецкая':'10002458',
}
audit=list(csv.DictReader((DATA/'owner_cascade_match_audit.csv').open(encoding='utf-8-sig')))
assign={}; provenance={}
for r in audit:
 name=r['source_list_name'];queue=r['source_list_queue']
 ident=OVERRIDES.get(name) or r['matched_id']
 if not ident:raise ValueError(f'No mapped ID: {name}')
 if ident in assign:raise ValueError(f'Duplicate selected ID {ident}: {name} and {provenance[ident]["source_list_name"]}')
 assign[ident]=queue
 provenance[ident]={'source_list_name':name,'match_mode':'ручная адресная сверка' if name in OVERRIDES else ('точное наименование' if r['match_mode']=='exact' else 'сверка сокращённого наименования'),'source_list_queue':queue}
assert Counter(assign.values())==Counter({'1':56,'3':46}),Counter(assign.values())
remaining=json.loads((LAYERS/'sao_remaining_wgs84.geojson').read_text('utf8'))
source_ids={str(f['properties']['id']) for f in remaining['features']}
assert len(source_ids)==591 and set(assign)<=source_ids
for ident in source_ids:assign.setdefault(ident,'2')
assert Counter(assign.values())==Counter({'1':56,'2':489,'3':46})
# Human-auditable full assignment ledger.
byid={}
for f in remaining['features']:byid.setdefault(str(f['properties']['id']),f['properties']['name'])
rows=[]
for ident in sorted(assign,key=lambda x:(int(x) if x.isdigit() else 10**20,x)):
 src=provenance.get(ident,{})
 rows.append({'id':ident,'name':byid[ident],'queue':assign[ident],'assignment_basis':src.get('match_mode','остаток после 1-й и 3-й очередей'),'source_list_name':src.get('source_list_name','')})
with (DATA/'owner_cascade_final_assignment.csv').open('w',newline='',encoding='utf-8-sig') as fh:
 w=csv.DictWriter(fh,fieldnames=list(rows[0]),delimiter=';');w.writeheader();w.writerows(rows)
(DATA/'owner_cascade_queue_assignment.json').write_text(json.dumps({'source':'Каскад очередности, подтверждённый пользователем 26.08.2026','total':591,'counts':dict(Counter(assign.values())),'assignments':assign},ensure_ascii=False,indent=2),encoding='utf8')

def collection(features,name):return {'type':'FeatureCollection','name':name,'features':features}
extra={'1':'Каскадная сверка: дополнено в 1-ю очередь по исторической разметке','2':'Каскадная сверка: 2-я очередь по остаточному принципу после 1-й и 3-й','3':'Каскадная сверка: 3-я очередь по зелёной разметке исторической карты'}
parts={'1':[],'2':[],'3':[]}
for f in remaining['features']:
 ident=str(f['properties']['id']);q=assign[ident]
 g=json.loads(json.dumps(f,ensure_ascii=False));g['properties']['wave']=q;g['properties']['queue_source']=extra[q];parts[q].append(g)
# Original list stays intact in source, but enters combined queue 1 with its provenance.
original=json.loads((LAYERS/'sao_wave1_complete_wgs84.geojson').read_text('utf8'))
base=[]
for f in original['features']:
 g=json.loads(json.dumps(f,ensure_ascii=False));g['properties']['wave']='1';g['properties']['queue_source']='Исходный список 1-й очереди (97 позиций)';base.append(g)
outputs={
 'sao_queue1_wgs84.geojson':collection(base+parts['1'],'САО — 1-я очередь (153 позиции)'),
 'sao_queue2_wgs84.geojson':collection(parts['2'],'САО — 2-я очередь (489 позиций)'),
 'sao_queue3_wgs84.geojson':collection(parts['3'],'САО — 3-я очередь (46 позиций)'),
}
for file,data in outputs.items():(STAGE/file).write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf8')
# Copy non-queue layers for the release bundle. The legacy no-queue layer is deliberately excluded.
for f in LAYERS.glob('*.geojson'):
 if f.name not in {'sao_remaining_wgs84.geojson','sao_wave1_complete_wgs84.geojson','sao_queue1_wgs84.geojson','sao_queue2_wgs84.geojson','sao_queue3_wgs84.geojson'}:
  (STAGE/f.name).write_bytes(f.read_bytes())
# Structural checks: every original remaining feature occurs exactly once in final 1/2/3 data.
for q,file,count in [('1','sao_queue1_wgs84.geojson',153),('2','sao_queue2_wgs84.geojson',489),('3','sao_queue3_wgs84.geojson',46)]:
 d=json.loads((STAGE/file).read_text('utf8'));logical={str(f['properties']['id']) for f in d['features']};
 if q=='1': assert len(logical)==153
 else: assert len(logical)==count
print('queue totals',Counter(assign.values()),'queue1 total',len({str(f['properties']['id']) for f in outputs['sao_queue1_wgs84.geojson']['features']}))
print('stage',STAGE)



