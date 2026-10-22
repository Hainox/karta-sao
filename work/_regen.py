import sys, importlib.util, json, pathlib
sys.stdout.reconfigure(encoding='utf-8')
spec = importlib.util.spec_from_file_location('builder', 'work/build_district_layer_maps.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
districts = {}
for f in json.loads(pathlib.Path('districts.geojson').read_text(encoding='utf-8'))['features']:
    g = f['geometry']
    polys = g['coordinates'] if g['type'] == 'MultiPolygon' else [g['coordinates']]
    districts[f['properties']['district']] = polys
m.write_pages(districts)
print('pages regenerated')
