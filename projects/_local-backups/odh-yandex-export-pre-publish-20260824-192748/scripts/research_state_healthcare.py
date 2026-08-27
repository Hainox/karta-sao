#!/usr/bin/env python3
"""Build an auditable state-healthcare candidate register for SAO from OSM map data.
This is a discovery list, not a legal register. It deliberately keeps verification status.
"""
from __future__ import annotations
import argparse,csv,json,re
from pathlib import Path
from urllib.parse import quote

FIELDS=['name','address','category','public_status','verification_status','osm_type','osm_id','latitude','longitude','official_evidence','yandex_maps_search','2gis_search','google_maps_search','note']
PRIVATE=re.compile(r'медси|ржд|ржд-медицина',re.I)
CITY=re.compile(r'гбуз|дзм|департамент здравоохранения|городская поликлиника|детская городская|городская клиническая|детская инфекционная|стоматологическая поликлиника|наркологическ|психоневрологическ|туберкулезн|мнпц|больница № ?50|больница для детей',re.I)
FEDERAL=re.compile(r'фгбу|фмба|министерств[оа] обороны|приорова|центральная клиническая психиатрическая',re.I)

def center(element):
 return element.get('lat',element.get('center',{}).get('lat')),element.get('lon',element.get('center',{}).get('lon'))
def main():
 p=argparse.ArgumentParser();p.add_argument('--input',type=Path,required=True);p.add_argument('--output-dir',type=Path,required=True);a=p.parse_args();a.output_dir.mkdir(parents=True,exist_ok=True)
 elements=json.loads(a.input.read_text(encoding='utf-8'))['elements']; rows=[];seen=set()
 for x in elements:
  t=x.get('tags',{});name=str(t.get('name','')).strip();operator=str(t.get('operator','')).strip();alltext=' '.join((name,operator,str(t.get('website',''))))
  if not name or PRIVATE.search(alltext) or not (CITY.search(alltext) or FEDERAL.search(alltext)):continue
  lat,lon=center(x)
  if lat is None or lon is None:continue
  address=', '.join(v for v in (t.get('addr:street'),t.get('addr:housenumber')) if v) or 'Адрес уточняется в агрегаторах/официальном источнике'
  key=(re.sub(r'\W+','',name.lower()),round(float(lat),4),round(float(lon),4))
  if key in seen:continue
  seen.add(key)
  status='кандидат: московское государственное учреждение' if CITY.search(alltext) else 'кандидат: федеральное/ведомственное государственное учреждение'
  query=f'{name}, {address}, Москва'; q=quote(query)
  rows.append({'name':name,'address':address,'category':t.get('healthcare') or t.get('amenity') or 'медицинская организация','public_status':status,'verification_status':'требуется подтверждение по официальному сайту и агрегаторам','osm_type':x['type'],'osm_id':x['id'],'latitude':lat,'longitude':lon,'official_evidence':'См. реестр/официальный сайт медицинской организации; автоматическая классификация не является подтверждением.','yandex_maps_search':f'https://yandex.ru/maps/?text={q}','2gis_search':f'https://2gis.ru/moscow/search/{q}','google_maps_search':f'https://www.google.com/maps/search/?api=1&query={q}','note':'Источник координат: OpenStreetMap. Ссылки ведут к поиску в трёх агрегаторах; не означают автоматическое подтверждение карточки.'})
 rows.sort(key=lambda r:(r['name'],r['address']))
 with (a.output_dir/'sao_state_healthcare_research.csv').open('w',encoding='utf-8-sig',newline='') as f:w=csv.DictWriter(f,fieldnames=FIELDS,delimiter=';');w.writeheader();w.writerows(rows)
 feats=[{'type':'Feature','geometry':{'type':'Point','coordinates':[float(r['longitude']),float(r['latitude'])]},'properties':r} for r in rows]
 (a.output_dir/'sao_state_healthcare_research_wgs84.geojson').write_text(json.dumps({'type':'FeatureCollection','metadata':{'record_count':len(rows),'scope':'Государственные учреждения: кандидаты по картографической базе; требуется верификация','boundary':'САО, включая Молжаниновский район','sources':'OpenStreetMap discovery + prepared searches in Yandex Maps, 2GIS, Google Maps'},'features':feats},ensure_ascii=False,indent=2),encoding='utf-8')
 print(f'Кандидатов: {len(rows)}')
if __name__=='__main__':main()
