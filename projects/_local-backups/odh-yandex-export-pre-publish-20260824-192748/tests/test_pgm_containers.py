from pathlib import Path
import csv,json

def test_pgm_table_has_records():
 with Path('outputs/sao_pgm_containers.csv').open(encoding='utf-8-sig',newline='') as f:
  assert len(list(csv.DictReader(f,delimiter=';'))) >= 400

def test_pgm_geojson_has_metadata():
 data=json.loads(Path('outputs/sao_pgm_containers_wgs84.geojson').read_text(encoding='utf-8'))
 assert data['metadata']['record_count'] >= 400
