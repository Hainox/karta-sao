from scripts.build_sao_maps import render_html

def test_html_uses_neutral_nolabel_basemap_not_blocked_osm_tiles():
    markup=render_html([],mode='interactive')
    assert 'tile.openstreetmap.org' not in markup
    assert 'basemaps.cartocdn.com/light_nolabels/' in markup
    assert 'L.tileLayer(' in markup
    assert 'attribution:""' in markup
