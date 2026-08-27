import json
from pathlib import Path

def test_boundary_includes_sao_and_molzhaninovsky():
 data=json.loads(Path('outputs/sao_boundary_wgs84.geojson').read_text(encoding='utf-8'))
 kinds={f['properties']['feature_kind'] for f in data['features']}
 assert {'boundary_sao','boundary_molzhaninovsky','district_label'} <= kinds
 assert data['metadata']['sao_relation_id']==162903
