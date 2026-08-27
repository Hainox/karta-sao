from scripts.build_sao_maps import render_html

def test_leaflet_visual_attribution_is_disabled():
    assert 'attributionControl:false' in render_html([],mode='interactive')
