from pathlib import Path

import json
import os
import subprocess
import sys
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


def test_dt5_route_strokes_do_not_fill_the_inner_driveway():
    """Route highlighting is linework only; SVG paths must not create black filled sectors."""
    svg = page("smm/dt5.svg")
    assert '<g fill="none" stroke="#fff" stroke-width="1.3"' in svg


def test_dt5_scheme_uses_a_versioned_asset_url_after_visual_fix():
    """An old cached SVG must not be reused after a visual correction."""
    markup = page("smm/index.html")
    assert "scheme:'dt5.svg?v=" in markup


def test_dt5_route_bypasses_the_building_outline():
    """The route must follow the exterior drive, not cross the building footprint."""
    svg = page("smm/dt5.svg")
    assert 'M733 200 Q695 290 660 372' in svg
    assert 'M747 245 Q533 443 242 316' not in svg


def test_smm_print_a3_form_is_self_contained_and_in_sync_with_generator():
    """The SMM print form must be A3-landscape, embed all five schemes and be regenerable byte-identically."""
    import shutil
    import tempfile

    repo = Path(__file__).resolve().parents[1]
    markup = page("smm/print-a3.html")
    assert "@page { size:A3 landscape" in markup
    assert 'id="printBtn"' in markup
    assert markup.count('<section class="card">') == 5
    for code in ("ДТ-1", "ДТ-2", "ДТ-3", "ДТ-4", "ДТ-5"):
        assert f"{code} ·" in markup
    assert markup.count("data:image/svg+xml;base64,") == 5
    assert "data:image/png;base64," in markup
    assert "<b>Маршрут:</b>" in markup  # маршрут отображается в печатной форме

    work_dir = Path(tempfile.mkdtemp(prefix="smm-print-test-", dir=repo / "work"))
    try:
        out = work_dir / "print-a3.html"
        subprocess.run(
            [sys.executable, "work/build_smm_print_a3.py", "--out", str(out)],
            check=True,
            cwd=repo,
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONUTF8": "1"},
        )
        assert out.read_text(encoding="utf-8") == markup
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


def test_smm_detail_drawer_has_complete_dt4_dt5_cards_and_single_navigation_entry():
    """DT-4 and DT-5 need operational cards without claiming ASU ODS contours."""
    markup = page("smm/index.html")
    assert markup.count('data-yard="dt5"') == 1
    for heading in (
        "ДТ-4 «Два корпуса»: технологическая карта",
        "ДТ-5 «Полукольцо»: технологическая карта",
    ):
        assert heading in markup
    for required_text in (
        "Н-4",
        "Н-5",
        "полевой осмотр",
        "не являются утверждённой технологической картой",
        "OpenStreetMap",
    ):
        assert required_text in markup


def test_root_map_exposes_smm_variants_and_direction_overlays():
    """Switching on SMM must reveal five quick-zoom variants and their route/nozzle vectors."""
    markup = page("index.html")
    assert 'id="smmVariants"' in markup
    assert 'function zoomToSmmVariant' in markup
    assert 'smm_routes' in markup

    data = json.loads(Path("smm_routes.geojson").read_text(encoding="utf-8"))
    variants = {feature["properties"]["variant_id"] for feature in data["features"]}
    assert variants == {"dt1", "dt2", "dt3", "dt4", "dt5"}
    assert any(feature["properties"]["feature_kind"] == "route_direction" for feature in data["features"])
    assert any(feature["properties"]["feature_kind"] == "nozzle_direction" for feature in data["features"])


def test_dt1_dt2_reference_routes_stay_in_inner_yard_not_external_perimeter():
    """The DT-1 and DT-2 reference routes follow internal courtyard passages only."""
    yards = {
        feature["id"]: shape(feature["geometry"])
        for feature in json.loads(Path("smm.geojson").read_text(encoding="utf-8"))["features"]
    }
    data = json.loads(Path("smm_routes.geojson").read_text(encoding="utf-8"))
    for variant in ("dt1", "dt2"):
        route = next(
            feature for feature in data["features"]
            if feature["properties"].get("variant_id") == variant
            and feature["properties"].get("feature_kind") == "route_direction"
        )
        inner_yard = yards[f"smm-{variant}"].buffer(-4 / 111320)
        assert route["properties"].get("route_origin") == "inner_yard_reference"
        assert all(inner_yard.covers(shape({"type": "Point", "coordinates": point})) for point in route["geometry"]["coordinates"])
        nozzle = next(
            feature for feature in data["features"]
            if feature["properties"].get("variant_id") == variant
            and feature["properties"].get("feature_kind") == "nozzle_direction"
        )
        assert nozzle["properties"].get("route_origin") == "inner_yard_reference"
        assert all(
            inner_yard.covers(shape({"type": "Point", "coordinates": point[:2]}))
            for point in nozzle["properties"].get("nozzle_track", [])
        )


def test_reference_routes_for_dt1_dt2_are_labeled_as_diagrams_not_gps():
    """Routes drawn from supplied sketches must remain preliminary design data."""
    data = json.loads(Path("smm_routes.geojson").read_text(encoding="utf-8"))
    for variant in ("dt1", "dt2"):
        route = next(
            feature for feature in data["features"]
            if feature["properties"].get("variant_id") == variant
            and feature["properties"].get("feature_kind") == "route_direction"
        )
        nozzle = next(
            feature for feature in data["features"]
            if feature["properties"].get("variant_id") == variant
            and feature["properties"].get("feature_kind") == "nozzle_direction"
        )
        assert route["properties"]["source"] == "reference_scheme"
        assert "приложенным схемам" in route["properties"]["status"].lower()
        assert nozzle["properties"]["source"] == "reference_scheme"


def test_smm_routes_overlay_skips_malformed_nozzle_measurements():
    """A bad nozzle row must not discard the rest of the measured vector field."""
    from work.build_smm_routes_overlay import load_nozzle_points

    path = Path("work") / "_malformed_nozzle_test.json"
    try:
        path.write_text(json.dumps({"points": [None, [37.5, 55.8], [37.5, 55.8, "bad"], [37.5, 55.8, 42]]}), encoding="utf-8")
        assert load_nozzle_points(path) == [(37.5, 55.8, 42.0)]
    finally:
        path.unlink(missing_ok=True)


def test_smm_routes_overlay_uses_gps_tracks_when_present():
    """GPX/nozzle tracks must replace schematic anchors; variants without tracks keep them."""
    import shutil
    import tempfile

    work_dir = Path(tempfile.mkdtemp(prefix="smm-track-test-", dir=Path(__file__).resolve().parents[1] / "work"))
    try:
        tracks = work_dir / "tracks"
        tracks.mkdir()
        (tracks / "dt1.gpx").write_text(
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">'
            '<trk><name>dt1</name><trkseg>'
            '<trkpt lat="55.79450" lon="37.51200"/>'
            '<trkpt lat="55.79450" lon="37.51240"/>'
            '<trkpt lat="55.79450" lon="37.51300"/>'
            '</trkseg></trk></gpx>',
            encoding="utf-8",
        )
        (tracks / "dt1.nozzle.json").write_text(
            json.dumps({"points": [[37.5123, 55.7942, 20], [37.5125, 55.7942, 25], [37.5127, 55.7942, 15]]}),
            encoding="utf-8",
        )
        out = work_dir / "smm_routes.geojson"
        subprocess.run(
            [sys.executable, "work/build_smm_routes_overlay.py", "--out", str(out), "--tracks-dir", str(tracks)],
            check=True,
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONUTF8": "1"},
        )

        data = json.loads(out.read_text(encoding="utf-8"))
        route = next(
            f for f in data["features"]
            if f["properties"]["variant_id"] == "dt1" and f["properties"]["feature_kind"] == "route_direction"
        )
        assert route["geometry"]["type"] == "LineString"
        assert len(route["geometry"]["coordinates"]) == 3
        assert abs(route["properties"]["bearing"] - 90) < 0.5
        assert route["properties"]["source"] == "gpx"

        nozzle = next(
            f for f in data["features"]
            if f["properties"]["variant_id"] == "dt1" and f["properties"]["feature_kind"] == "nozzle_direction"
        )
        assert nozzle["properties"]["source"] == "json"
        assert abs(nozzle["properties"]["bearing"] - 20) < 2.0
        assert nozzle["properties"]["nozzle_track"] == [[37.5123, 55.7942, 20], [37.5125, 55.7942, 25], [37.5127, 55.7942, 15]]

        markup = page("index.html")
        assert "nozzle-measure" in markup
        assert "feature.properties.nozzle_track" in markup
        assert "замер выброса №" in markup
        assert "measure.length < 3" in markup
        assert "Number.isFinite(longitude)" in markup

        schematic = next(
            f for f in data["features"]
            if f["properties"]["variant_id"] == "dt2" and f["properties"]["feature_kind"] == "route_direction"
        )
        assert schematic["geometry"]["type"] == "Point"
        assert "source" not in schematic["properties"]
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
