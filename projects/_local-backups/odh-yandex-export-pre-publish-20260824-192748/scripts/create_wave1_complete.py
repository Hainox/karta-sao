#!/usr/bin/env python3
"""Complete first-wave representation without mislabelling markers as ODH polygons."""
from __future__ import annotations
import argparse,csv,json
from pathlib import Path

MARKERS={
 "53": (37.5680,55.8817,'Ориентир МЦД Бескудниково; точечный маркер, не граница ОДХ или ТПУ.'),
 "68": (37.4768120,55.8548129,'Ориентир у станции метро «Речной вокзал»; точечный маркер, не граница ТПУ.'),
 "91": (37.5379,55.7870,'Ориентир у станции метро «ЦСКА»; точечный маркер, не граница ТПУ.'),
}
FIELDS=['seq_ao','source_name','registry_id','registry_name','match_method','representation','verification','longitude','latitude']

def main()->int:
 p=argparse.ArgumentParser();p.add_argument('--data-dir',type=Path,required=True);p.add_argument('--match-report',type=Path,required=True);p.add_argument('--output-dir',type=Path,required=True);a=p.parse_args();a.output_dir.mkdir(parents=True,exist_ok=True)
 road=json.loads((a.data_dir/'sao_wave1_wgs84.geojson').read_text(encoding='utf-8')); features=list(road['features'])
 with a.match_report.open(encoding='utf-8-sig',newline='') as f: rows=list(csv.DictReader(f,delimiter=';'))
 objects=[]
 for r in rows:
  source=r['Название в списке']; method=r['Метод']; record={'seq_ao':r['№ в АО'],'source_name':source,'registry_id':r['ID реестра'],'registry_name':r['Найдено в реестре'],'match_method':method,'representation':'geometry_from_registry' if method!='no_match' else 'location_marker','verification':'confirmed_registry_match' if method=='exact' else 'manual_review_required','longitude':'','latitude':''}
  if method=='no_match':
   if r['№ в АО'] not in MARKERS: raise ValueError(f'Нет маркера для: {source}')
   lon,lat,note=MARKERS[r['№ в АО']]; record.update({'verification':note,'longitude':lon,'latitude':lat})
   features.append({'type':'Feature','geometry':{'type':'Point','coordinates':[lon,lat]},'properties':{'id':f'marker-wave1-{r["№ в АО"]}','name':source,'wave':'1','feature_kind':'location_marker','source_list_number':r['№ в АО'],'warning':note,'color':'#e53935'}})
  objects.append(record)
 assert len(objects)==97, len(objects)
 assert sum(1 for x in objects if x['representation']=='location_marker')==3
 result={'type':'FeatureCollection','name':'САО — первая очередь (97 позиций)','metadata':{'object_count':97,'registry_geometry_object_count':94,'location_marker_count':3,'note':'Маркеры не являются кадастровыми или юридическими границами.'},'features':features}
 (a.output_dir/'sao_wave1_complete_wgs84.geojson').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
 with (a.output_dir/'sao_wave1_complete_objects.csv').open('w',encoding='utf-8-sig',newline='') as f: w=csv.DictWriter(f,fieldnames=FIELDS,delimiter=';');w.writeheader();w.writerows(objects)
 print(f'Первая очередь: {len(objects)} позиций; геометрия реестра: 94; маркеры: 3; GeoJSON-геометрий: {len(features)}')
 return 0
if __name__=='__main__':raise SystemExit(main())
