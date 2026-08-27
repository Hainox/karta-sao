from pathlib import Path
import csv,json

def test_wave1_has_exactly_97_objects():
 data=json.loads(Path('outputs/sao_wave1_complete_wgs84.geojson').read_text(encoding='utf-8'))
 assert data['metadata']['object_count']==97
 assert data['metadata']['registry_geometry_object_count']==94
 assert data['metadata']['location_marker_count']==3

def test_wave1_object_csv_has_97_rows():
 with Path('outputs/sao_wave1_complete_objects.csv').open(encoding='utf-8-sig',newline='') as stream:
  assert len(list(csv.DictReader(stream,delimiter=';')))==97
