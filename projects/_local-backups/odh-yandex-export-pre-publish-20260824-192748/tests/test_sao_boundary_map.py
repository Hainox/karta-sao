from scripts.build_sao_maps import SPECS,render_html

def test_map_has_sao_boundary_layer():
    assert any(x.key=='boundary' and 'Молжаниновский' in x.name for x in SPECS)
    assert 'weight:b?5:2' in render_html([],mode='interactive')
