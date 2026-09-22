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
        assert "@page{size:297mm 420mm;margin:10mm}" in page("yards-print/index.html")


def test_hub_is_navigation_only_and_has_two_catalog_sections():
    markup = page("hub/index.html")
    assert "Рабочие карты" in markup
    assert "Печатные формы" in markup
    assert "../yards-print/" in markup
    assert "<iframe" not in markup


def test_prefecture_review_cabinet_is_linked_and_has_safe_review_controls():
    markup = page("review-cabinet/index.html")
    assert "Кабинет приёмки" in markup
    assert "На доработку" in markup
    assert "Укажите причину возврата на доработку" in markup
    assert "Принятое фото автоматически станет эталонным" in markup
    assert "Сделать эталонным" not in markup
    assert "Комментарий района" in markup
    assert "/review/claim" in markup
    assert "/review/history" in markup
    assert "История проверок" in markup
    assert "X-Review-Session" in markup
    assert "/review/queue" in markup
    assert "https://obhod-sao.ru/photo-api" in markup
    assert "credentials:'include',cache:'no-store',headers:headers()" in markup
    assert "review-cabinet" in page("hub/index.html")


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


def test_odh_point_symbols_are_centered_and_route_detail_tracks_zoom():
    """ОДХ point icons have a stable centered hitbox while route detail follows zoom."""
    markup = page("odh-map/index.html")
    assert ".point-icon" in markup
    assert "iconSize: [24, 24]" in markup
    assert "iconAnchor: [12, 12]" in markup
    assert 'function routeDetailLevel(zoom = map.getZoom())' in markup
    assert 'if (zoom < 12.75) return "overview"' in markup
    assert 'if (zoom < 14) return "context"' in markup
    assert 'map.on("zoomend", syncRouteDetail)' in markup
    assert "refreshDirections();" in markup


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


def test_queue_manifest_matches_the_published_priority_counts():
    """The public ОДХ print and interactive map use one consistent queue count."""
    layer_dir = Path("odh-map/layers")
    manifest = json.loads((Path("odh-map") / "layers.json").read_text(encoding="utf-8"))
    queue1 = next(layer for layer in manifest["layers"] if layer["key"] == "queue1")
    assert "98" in queue1["name"]

    data = json.loads((layer_dir / "sao_queue1_wgs84.geojson").read_text(encoding="utf-8"))
    queue_sources = {feature["properties"].get("queue_source") for feature in data["features"]}
    assert len(queue_sources) == 1
    assert "Очередность_уборки_округ.xlsx" in next(iter(queue_sources))
    assert len({feature["properties"]["id"] for feature in data["features"]}) <= 98

    assert "318" in next(layer for layer in manifest["layers"] if layer["key"] == "queue2")["name"]
    assert "272" in next(layer for layer in manifest["layers"] if layer["key"] == "queue3")["name"]


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
            encoding="utf-8",
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


def test_root_map_no_longer_carries_the_smm_layer():
    """Слой «Маршруты СММ» убран с корневой карты по требованию заказчика и не должен вернуться."""
    markup = page("index.html")
    assert 'id="smmVariants"' not in markup
    assert "function zoomToSmmVariant" not in markup
    assert "function isSmmVariantVisible(variantId)" not in markup
    assert "function routeArrowPositions(coordinates" not in markup
    assert "smm_routes.geojson" not in markup
    assert "Маршруты СММ" not in markup
    # Соседний слой остаётся: это объекты ОДХ, а не маршруты.
    assert "Места хранения СММ" in markup


def test_root_map_filters_urn_clusters_with_selected_area():
    """Выбор района и участка фильтрует кластеры урн на корневой карте."""
    markup = page("index.html")
    assert "state.urnsClusterer.update({ features: records.filter(isVisible)" in markup
    assert "state.layers.urns?.enabled" in markup


def test_smm_routes_overlay_keeps_five_outlines_and_district_on_every_direction():
    """Данные секции СММ остаются полными: пять контуров и район у каждого направления."""
    routes = json.loads(Path("smm_routes.geojson").read_text(encoding="utf-8"))
    outlines = {
        feature["properties"]["variant_id"]: feature["properties"]
        for feature in routes["features"]
        if feature["properties"].get("feature_kind") == "variant_outline"
    }
    directions = [
        feature for feature in routes["features"]
        if feature["properties"].get("feature_kind") in {"route_direction", "nozzle_direction"}
    ]
    assert len(outlines) == 5
    assert all(outlines[feature["properties"]["variant_id"]].get("district") for feature in directions)


def test_dt2_map_card_uses_the_same_address_as_its_published_geometry():
    """The SMM selector and quick-zoom metadata must name the corrected ASU address."""
    markup = page("smm/index.html")
    assert "ул. Дубнинская, д. 30Б · Восточное Дегунино" in markup
    assert "addr:'ул. Дубнинская, д. 30Б'" in markup
    assert "addr:'ул. Дубнинская, д. 30'" not in markup


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
        assert "по приложенной схеме" in route["properties"]["status"].lower()
        assert route["properties"]["route_origin"] == "inner_yard_reference"
        assert nozzle["properties"]["source"] == "reference_scheme"


def test_dt3_reference_route_uses_the_supplied_comb_diagram_inside_the_yard():
    """The third supplied diagram is a preliminary internal courtyard route, not GPS."""
    yards = {
        feature["id"]: shape(feature["geometry"])
        for feature in json.loads(Path("smm.geojson").read_text(encoding="utf-8"))["features"]
    }
    data = json.loads(Path("smm_routes.geojson").read_text(encoding="utf-8"))
    yard = yards["smm-dt3"]
    for kind in ("route_direction", "nozzle_direction"):
        feature = next(
            feature for feature in data["features"]
            if feature["properties"].get("variant_id") == "dt3"
            and feature["properties"].get("feature_kind") == kind
        )
        assert feature["properties"].get("route_origin") == "inner_yard_reference"
        assert feature["properties"].get("source") == "reference_scheme"
    route = next(
        feature for feature in data["features"]
        if feature["properties"].get("variant_id") == "dt3"
        and feature["properties"].get("feature_kind") == "route_direction"
    )
    assert yard.covers(shape(route["geometry"]))


def test_smm_routes_overlay_skips_malformed_nozzle_measurements():
    """A bad nozzle row must not discard the rest of the measured vector field."""
    from work.build_smm_routes_overlay import load_nozzle_points

    path = Path("work") / "_malformed_nozzle_test.json"
    try:
        path.write_text(json.dumps({"points": [None, [37.5, 55.8], [37.5, 55.8, "bad"], [37.5, 55.8, 42]]}), encoding="utf-8")
        assert load_nozzle_points(path) == [(37.5, 55.8, 42.0)]
    finally:
        path.unlink(missing_ok=True)


def test_smm_routes_overlay_uses_tracks_with_explicit_provenance():
    """A declared GPS track replaces schematic anchors; GPX alone does not imply GPS."""
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
            json.dumps({
                "route_source_kind": "gps",
                "nozzle_source_kind": "measurement",
                "points": [[37.5123, 55.7942, 20], [37.5125, 55.7942, 25], [37.5127, 55.7942, 15]],
            }),
            encoding="utf-8",
        )
        out = work_dir / "smm_routes.geojson"
        subprocess.run(
            [sys.executable, "work/build_smm_routes_overlay.py", "--out", str(out), "--tracks-dir", str(tracks)],
            check=True,
            cwd=Path(__file__).resolve().parents[1],
            capture_output=True,
            text=True,
            encoding="utf-8",
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
        assert nozzle["properties"]["source"] == "measurement"
        assert nozzle["properties"]["nozzle_origin"] == "measurement"
        assert abs(nozzle["properties"]["bearing"] - 20) < 2.0
        assert nozzle["properties"]["nozzle_track"] == [[37.5123, 55.7942, 20], [37.5125, 55.7942, 25], [37.5127, 55.7942, 15]]

        # Отрисовка этих маркеров жила на корневой карте; слой снят, поэтому проверяется
        # только контракт самих данных — их полноту стережёт отдельный тест.

        schematic = next(
            f for f in data["features"]
            if f["properties"]["variant_id"] == "dt2" and f["properties"]["feature_kind"] == "route_direction"
        )
        assert schematic["geometry"]["type"] == "Point"
        assert "source" not in schematic["properties"]
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)
