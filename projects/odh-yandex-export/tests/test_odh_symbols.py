from scripts.build_sao_maps import render_html, symbol_svg


def test_symbol_svg_uses_approved_shapes_and_colors():
    expected = {
        "wave1": ("#e53935", "road"),
        "remaining": ("#757575", "road"),
        "pgm": ("#c05600", "container"),
        "snow": ("#039be5", "snowflake"),
        "healthcare": ("#c62828", "medical"),
    }

    for kind, (color, shape) in expected.items():
        markup = symbol_svg(kind, color)
        assert f'data-kind="{shape}"' in markup
        assert f"--symbol-color:{color}" in markup


def test_generated_map_uses_div_icons_not_circle_markers_and_has_attribution():
    markup = render_html([], mode="interactive")

    assert "L.circleMarker" not in markup
    assert "L.divIcon" in markup
    assert "© OpenStreetMap contributors" in markup
    assert "© CARTO" in markup
