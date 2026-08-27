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


def test_healthcare_layer_has_only_officially_confirmed_points_and_expected_gp6_branches():
    """Public healthcare points require a first-party source and readable Russian labels."""
    layer_dir = Path("odh-map/layers")
    confirmed = json.loads((layer_dir / "sao_state_healthcare_confirmed_wgs84.geojson").read_text(encoding="utf-8"))
    assert len(confirmed["features"]) == 20
    for feature in confirmed["features"]:
        props = feature["properties"]
        assert props.get("official_source", "").startswith("https://")
        assert "_" not in " ".join(str(value) for value in props.values())

    gp6 = {
        feature["properties"]["address"]
        for feature in confirmed["features"]
        if "\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u043f\u043e\u043b\u0438\u043a\u043b\u0438\u043d\u0438\u043a\u0430 \u2116 6" in feature["properties"].get("name", "")
    }
    assert gp6 == {
        "\u041c\u043e\u0441\u043a\u0432\u0430, \u0443\u043b\u0438\u0446\u0430 \u0412\u0443\u0447\u0435\u0442\u0438\u0447\u0430, 7\u0411",
        "\u041c\u043e\u0441\u043a\u0432\u0430, 1-\u044f \u041a\u0432\u0435\u0441\u0438\u0441\u0441\u043a\u0430\u044f \u0443\u043b\u0438\u0446\u0430, 8",
        "\u041c\u043e\u0441\u043a\u0432\u0430, 3-\u0439 \u041c\u0438\u0445\u0430\u043b\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u043f\u0435\u0440\u0435\u0443\u043b\u043e\u043a, 22",
        "\u041c\u043e\u0441\u043a\u0432\u0430, 3-\u0439 \u041d\u043e\u0432\u043e\u043c\u0438\u0445\u0430\u043b\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u043f\u0440\u043e\u0435\u0437\u0434, 3\u0410, \u0441\u0442\u0440\u043e\u0435\u043d\u0438\u0435 1",
        "\u041c\u043e\u0441\u043a\u0432\u0430, \u0443\u043b\u0438\u0446\u0430 \u041d\u0435\u043c\u0447\u0438\u043d\u043e\u0432\u0430, 14",
        "\u041c\u043e\u0441\u043a\u0432\u0430, \u0443\u043b\u0438\u0446\u0430 \u042e\u043d\u043d\u0430\u0442\u043e\u0432, 12",
    }


def test_first_queue_is_fixed_at_97_and_excludes_cascade_duplicates():
    """The 56 cascade matches are duplicate references, not extra first-queue objects."""
    layer_dir = Path("odh-map/layers")
    manifest = json.loads((Path("odh-map") / "layers.json").read_text(encoding="utf-8"))
    queue1 = next(layer for layer in manifest["layers"] if layer["key"] == "queue1")
    assert "97" in queue1["name"]
    assert "153" not in queue1["name"]

    data = json.loads((layer_dir / "sao_queue1_wgs84.geojson").read_text(encoding="utf-8"))
    queue_sources = {feature["properties"].get("queue_source") for feature in data["features"]}
    assert len(queue_sources) == 1
    assert "97" in next(iter(queue_sources))
    assert len({feature["properties"]["id"] for feature in data["features"]}) <= 97

    assert "489" in next(layer for layer in manifest["layers"] if layer["key"] == "queue2")["name"]
    assert "46" in next(layer for layer in manifest["layers"] if layer["key"] == "queue3")["name"]


def test_smm_storage_locations_are_published_from_winter_register_inside_sao():
    """Winter SMM storage locations must be a distinct, inspectable ODH map layer."""
    layer_dir = Path("odh-map/layers")
    manifest = json.loads((Path("odh-map") / "layers.json").read_text(encoding="utf-8"))
    storage_layer = next(layer for layer in manifest["layers"] if layer["key"] == "smm_storage")
    assert "СММ" in storage_layer["name"]

    boundary = shape(json.loads((layer_dir / "sao_boundary_wgs84.geojson").read_text(encoding="utf-8"))["features"][0]["geometry"])
    data = json.loads((layer_dir / "sao_smm_storage_locations_wgs84.geojson").read_text(encoding="utf-8"))
    assert len(data["features"]) >= 300
    for feature in data["features"]:
        assert boundary.covers(shape(feature["geometry"]))
        props = feature["properties"]
        assert props["address"]
        assert props["source_rows"] >= 1
        assert props["smm_units"] >= 0


def test_smm_routes_include_staropetrovsky_variant():
    """The fifth SMM variant must be selectable and retain its source qualification."""
    markup = page("smm/index.html")
    assert 'data-yard="dt5"' in markup
    assert "Старопетровский" in markup

    data = json.loads(Path("smm.geojson").read_text(encoding="utf-8"))
    feature = next(feature for feature in data["features"] if feature["id"] == "smm-dt5")
    assert feature["properties"]["address"] == "Старопетровский проезд, д. 10Б"
    assert "требует" in feature["properties"]["geometry_status"].lower()
