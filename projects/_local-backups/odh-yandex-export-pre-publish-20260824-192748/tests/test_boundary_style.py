from scripts.build_sao_maps import SPECS,render_html

def test_boundary_uses_high_contrast_thick_stroke():
    boundary=next(x for x in SPECS if x.key=='boundary')
    assert boundary.color=='#6a1b9a'
    assert 'weight:b?5:2' in render_html([],mode='interactive')
