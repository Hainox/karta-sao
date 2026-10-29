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
    assert "/reports/review.xlsx" in markup
    assert "Excel: свод по фото" in markup
    assert "exportReport" in markup
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


def test_smm_routes_and_district_markup_are_removed_from_the_atlas():
    """«Маршруты СММ» и районная разметка ОДХ сняты с сайта по решению заказчика 2026-10-28."""
    for removed in ("smm/index.html", "smm/print-a3.html", "smm_routes.geojson", "smm.geojson",
                    "odh-map/district-editor.html", "odh-map/district-links.html", "odh-map/prefecture-guide.html"):
        assert not Path(removed).exists(), removed
    for path in ("hub/index.html", "odh-map/index.html", "odh-map/district-review.html"):
        markup = page(path)
        for link in ("smm/", "district-editor.html", "odh-map/district-links.html", "prefecture-guide.html", "Нужно расчерчивать"):
            assert link not in markup, (path, link)
    assert 'href="district-links.html"' not in page("odh-map/index.html")
    assert 'href="district-links.html"' not in page("odh-map/district-review.html")


def test_hub_starts_with_tasks_and_compact_district_grid():
    """Хаб «по задачам»: четыре плитки задач, районы — сетка кнопок, поиск, печатные формы свёрнуты."""
    markup = page("hub/index.html")
    assert markup.count('class="task-tile"') == 4
    assert markup.count('class="map-card district-chip"') == 16
    assert 'id="hubSearch"' in markup and 'id="noResults"' in markup
    assert '<details class="catalog-section print-box"' in markup
    for target in ("../districts/review.html", "../object-maps/tpu-review.html", "review-cabinet"):
        assert target in markup


def test_hub_dashboard_shows_public_summary_and_prefecture_details():
    """Сводка округа: погода, ход работ и новости — всем; районы и лента дел — после входа префектуры."""
    markup = page("hub/index.html")
    for fragment in ('id="dashboard"', 'id="weather"', 'id="work"', 'id="news"', 'id="prefBody" hidden',
                     "/dashboard/summary", "/dashboard/news", "/dashboard/details", "api.open-meteo.com"):
        assert fragment in markup, fragment
    assert "[hidden] { display:none !important; }" in markup
