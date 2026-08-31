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
