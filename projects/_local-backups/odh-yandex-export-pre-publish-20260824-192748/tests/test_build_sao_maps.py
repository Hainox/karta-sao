from scripts.build_sao_maps import render_html

def test_print_markup_declares_a3_landscape():
 assert '@page{size:A3 landscape' in render_html([],mode='print')

def test_markup_contains_marker_warning():
 assert 'не юридические/кадастровые границы' in render_html([],mode='interactive')

def test_interactive_markup_uses_atlas_workspace_design():
 markup=render_html([],mode='interactive')
 assert 'class="topbar"' in markup
 assert 'class="workspace"' in markup
 assert 'class="panel-heading"' in markup
 assert 'class="map-overlay"' in markup
 assert 'Городской атлас САО' in markup
