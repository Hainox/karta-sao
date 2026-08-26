from pathlib import Path

import json
from shapely.geometry import shape


def page(relative: str) -> str:
    return Path(relative).read_text(encoding="utf-8")


def test_yard_and_print_pages_declare_shared_atlas_shell():
    for path in ("index.html", "yards-print/index.html"):
        markup = page(path)
        assert "Городской атлас САО" in markup
        assert "brand-mark" in markup
        assert "@page{size:A3 landscape" in page("yards-print/index.html")


def test_hub_is_navigation_only_and_has_two_catalog_sections():
    markup = page("hub/index.html")
    assert "Рабочие карты" in markup
    assert "Печатные формы" in markup
    assert "../yards-print/" in markup
    assert "<iframe" not in markup


def test_odh_point_symbols_stay_within_sao_boundary_and_dry_snow_dumps_are_published():
    """No point icon may be published outside the declared SAO boundary."""
    layer_dir = Path("odh-map/layers")
    boundary = shape(json.loads((layer_dir / "sao_boundary_wgs84.geojson").read_text(encoding="utf-8"))["features"][0]["geometry"])
    for layer_path in layer_dir.glob("*.geojson"):
        filename = layer_path.name
        data = json.loads((layer_dir / filename).read_text(encoding="utf-8"))
        for feature in data["features"]:
            geometry = shape(feature["geometry"])
            if geometry.geom_type in {"Point", "MultiPoint"}:
                assert boundary.covers(geometry), f"{filename}: {feature.get('properties', {}).get('name')}"

    dumps = json.loads((layer_dir / "sao_dry_snow_dumps_wgs84.geojson").read_text(encoding="utf-8"))
    assert len(dumps["features"]) == 3
    assert {f["properties"]["address"] for f in dumps["features"]} == {
        "ул. Ижорская, вл. 4",
        "пр-д Черепановых, вл. 2-6",
        "Машкинское ш., вл. 38",
    }
