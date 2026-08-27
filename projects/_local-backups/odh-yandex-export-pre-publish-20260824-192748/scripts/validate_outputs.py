#!/usr/bin/env python3
"""Validate output counts and make a machine-readable handoff report."""
from __future__ import annotations
import csv,json
from collections import Counter
from pathlib import Path
OUT=Path('outputs')
def features(name): return json.loads((OUT/name).read_text(encoding='utf-8'))
def csv_rows(name):
 with (OUT/name).open(encoding='utf-8-sig',newline='') as f:return list(csv.DictReader(f,delimiter=';'))
wave=features('sao_wave1_complete_wgs84.geojson'); remaining=features('sao_remaining_wgs84.geojson') if (OUT/'sao_remaining_wgs84.geojson').exists() else None
objects=csv_rows('sao_wave1_complete_objects.csv'); pgm=csv_rows('sao_pgm_containers.csv'); snow=csv_rows('sao_snow_storage_sites.csv'); review=csv_rows('sao_wave1_match_review.csv'); healthcare=csv_rows('sao_state_healthcare_confirmed.csv')
report={'snapshot_date':'2026-08-24','first_wave':{'required_count':97,'represented_count':len(objects),'registry_geometry_objects':wave['metadata']['registry_geometry_object_count'],'location_markers':wave['metadata']['location_marker_count'],'geojson_geometries':len(wave['features']),'match_methods':dict(Counter(x['match_method'] for x in review))},'remaining_odh':{'objects':594,'source':'preserved reestr-ogh.mos.ru export','note':'Raw MSK-77 and WGS-84 files are in the preserved source snapshot; rerun sao_export_remaining.py for a fresh export.'},'snow_storage_2025_2026':{'address_records':len(snow),'geocode_statuses':dict(Counter(x['geocode_status'] for x in snow)),'map_markers':len(features('sao_snow_storage_sites_wgs84.geojson')['features'])},'pgm_containers_2025_2026':{'placement_records':len(pgm),'container_total':sum(int(x['container_count']) for x in pgm if x['container_count'].isdigit()),'odh_geometry_proxies':len(features('sao_pgm_containers_wgs84.geojson')['features']),'unmatched_odh_records':sum(x['geometry_status']=='no_odh_geometry_match' for x in pgm)},'state_healthcare':{'officially_confirmed_map_points':len(healthcare),'candidate_records_held_out_of_map':len(csv_rows('sao_state_healthcare_research.csv')),'coordinate_system':'WGS84 / EPSG:4326','note':'Ten records were checked against an official organisation page; map-aggregator links are provided in each card for manual reconciliation.'},'blockers':['4 fuzzy name matches need manual confirmation before operational use.','3 first-wave markers are location references, not cadastral or legal boundaries.','18 snow-storage addresses were not resolved by the geocoder; verify them internally.','Hydrants, DEU bases, reagent stores and SSP MVS/MVK are not added without verified source datasets.','40 healthcare candidate records remain outside the map pending official-source verification.']}
assert report['first_wave']['represented_count']==97
assert report['pgm_containers_2025_2026']['container_total']==451
assert report['state_healthcare']['officially_confirmed_map_points']==10
(OUT/'sao_export_validation.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(report,ensure_ascii=False,indent=2))
