import json
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]


def test_urns_layer_is_published_as_geojson_and_downloadable_kml():
    markup = (REPO / "index.html").read_text(encoding="utf-8")
    data = json.loads((REPO / "urns_sao_active_snapshot.geojson").read_text(encoding="utf-8"))

    assert "urns" in markup
    assert "urns_sao_active_snapshot.kml" in markup
    assert "YMapClusterer" in markup
    assert "clusterByGrid" in markup
    assert "registerCdn" in markup
    assert "map-marker-urns" in markup
    assert (REPO / "urns_sao_active_snapshot.kml").is_file()
    assert data["type"] == "FeatureCollection"
    assert len(data["features"]) == 27029
    assert all(feature["geometry"]["type"] == "Point" for feature in data["features"])
    assert all(
        -180 <= feature["geometry"]["coordinates"][0] <= 180
        and -90 <= feature["geometry"]["coordinates"][1] <= 90
        for feature in data["features"]
    )


def test_urns_layer_metadata_declares_source_and_active_snapshot_scope():
    manifest = json.loads((REPO / "layers-manifest.json").read_text(encoding="utf-8"))
    layer = manifest["layers"]["urns"]

    assert layer["file"] == "urns_sao_active_snapshot.geojson"
    assert layer["kml_file"] == "urns_sao_active_snapshot.kml"
    assert layer["loaded"] == 27029
    assert layer["coordinate_system"] == "WGS84"
    assert layer["included_statuses"] == ["approved", "external_system_agreement"]


SAO_DISTRICTS = {
    "Аэропорт", "Беговой", "Бескудниковский", "Войковский", "Восточное Дегунино", "Головинский",
    "Дмитровский", "Западное Дегунино", "Коптево", "Левобережный", "Молжаниновский", "Савеловский",
    "Сокол", "Тимирязевский", "Ховрино", "Хорошевский",
}


def test_every_urn_inside_sao_has_exactly_one_district():
    """Район урны без района в источнике берётся по границе района; участок не выдумывается."""
    data = json.loads((REPO / "urns_sao_active_snapshot.geojson").read_text(encoding="utf-8"))
    districts = {feature["properties"]["district"] for feature in data["features"]}

    assert districts <= SAO_DISTRICTS | {""}, districts - SAO_DISTRICTS
    by_boundary = [f for f in data["features"] if f["properties"].get("district_source") == "boundary"]
    assert len(by_boundary) > 4000
    assert all(f["properties"]["district"] in SAO_DISTRICTS for f in by_boundary)
    assert all(f["properties"]["section"] == "" for f in by_boundary)


def test_urns_kml_matches_geojson_districts_and_folder_counts():
    import re

    data = json.loads((REPO / "urns_sao_active_snapshot.geojson").read_text(encoding="utf-8"))
    kml = (REPO / "urns_sao_active_snapshot.kml").read_text(encoding="utf-8")
    folders = re.findall(r"<Folder><name>([^<]*) \((\d+)\)</name>(.*?)</Folder>", kml, re.S)
    district_of = {f["id"]: f["properties"]["district"] or "Без района" for f in data["features"]}

    assert sum(body.count("<Placemark>") for _, _, body in folders) == len(data["features"])
    for name, count, body in folders:
        ids = re.findall(r"ID: (\S+)", body)
        assert int(count) == len(ids), name
        assert {district_of[i] for i in ids} == {name}
