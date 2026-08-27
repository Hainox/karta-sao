from scripts.build_sao_maps import render_html

def test_molzhaninovsky_label_is_not_permanent_on_map():
    assert "bindTooltip(f.properties.name" not in render_html([],mode='interactive')
