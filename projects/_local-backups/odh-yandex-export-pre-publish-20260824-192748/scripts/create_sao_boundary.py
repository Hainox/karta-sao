#!/usr/bin/env python3
"""Download visualization boundary layers for SAO and Molzhaninovsky District from OSM/Nominatim."""
from __future__ import annotations
import argparse,json
from pathlib import Path
import requests
HEADERS={'User-Agent':'SAO-map-preparation/1.0'}

def get_geojson(url,params):
 r=requests.get(url,params=params,headers=HEADERS,timeout=30);r.raise_for_status();return r.json()

def main():
 p=argparse.ArgumentParser();p.add_argument('--output-dir',type=Path,required=True);a=p.parse_args();a.output_dir.mkdir(parents=True,exist_ok=True)
 sao=get_geojson('https://nominatim.openstreetmap.org/lookup',{'osm_ids':'R162903','format':'geojson','polygon_geojson':1})['features'][0]
 sao['properties']={'name':'Граница Северного административного округа','feature_kind':'boundary_sao','source':'OpenStreetMap relation 162903; визуализационная граница, сверять с официальными документами при юридическом использовании.'}
 molz=get_geojson('https://nominatim.openstreetmap.org/search',{'q':'Молжаниновский район, Москва','format':'geojson','polygon_geojson':1,'limit':1})['features'][0]
 molz['properties']={'name':'Молжаниновский район — в составе САО','feature_kind':'boundary_molzhaninovsky','source':'OpenStreetMap/Nominatim; отображается отдельно, чтобы не потерять удалённую часть округа.'}
 label={'type':'Feature','geometry':{'type':'Point','coordinates':[37.3833,55.9448]},'properties':{'name':'Молжаниновский район (САО)','feature_kind':'district_label','source':'Подпись ориентировочная; граница района показана отдельным контуром.'}}
 collection={'type':'FeatureCollection','metadata':{'source':'OpenStreetMap/Nominatim, downloaded 2026-08-24','sao_relation_id':162903,'note':'Отображение включает Молжаниновский район как отдельную северо-западную часть САО.'},'features':[sao,molz,label]}
 (a.output_dir/'sao_boundary_wgs84.geojson').write_text(json.dumps(collection,ensure_ascii=False,indent=2),encoding='utf-8')
 print('Граница САО и Молжаниновский район сохранены.')
if __name__=='__main__':main()
