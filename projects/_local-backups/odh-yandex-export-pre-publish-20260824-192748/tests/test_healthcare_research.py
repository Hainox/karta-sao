import csv,json
from pathlib import Path

def test_healthcare_research_has_map_searches_and_no_private_medsi():
 with Path('outputs/sao_state_healthcare_research.csv').open(encoding='utf-8-sig',newline='') as f:rows=list(csv.DictReader(f,delimiter=';'))
 assert len(rows) >= 30
 assert all('yandex.ru/maps/' in r['yandex_maps_search'] and '2gis.ru/' in r['2gis_search'] and 'google.com/maps/' in r['google_maps_search'] for r in rows)
 assert not any('медси' in r['name'].lower() for r in rows)

def test_healthcare_geojson_count_matches_csv():
 with Path('outputs/sao_state_healthcare_research.csv').open(encoding='utf-8-sig',newline='') as f:rows=list(csv.DictReader(f,delimiter=';'))
 data=json.loads(Path('outputs/sao_state_healthcare_research_wgs84.geojson').read_text(encoding='utf-8'))
 assert data['metadata']['record_count']==len(rows)==len(data['features'])
