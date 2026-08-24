import csv
import json
from pathlib import Path


def _rows():
    with Path("outputs/sao_state_healthcare_confirmed.csv").open(encoding="utf-8-sig", newline="") as fh:
        return list(csv.DictReader(fh, delimiter=";"))


def test_confirmed_healthcare_has_only_officially_sourced_sites():
    rows = _rows()
    assert len(rows) == 10
    assert all(row["verification_status"].startswith("подтверждено официальным сайтом") for row in rows)
    assert all(row["official_source"].startswith("https://") for row in rows)
    assert all("государственное учреждение" in row["ownership"] for row in rows)
    assert any("Синявинская" in row["address"] for row in rows)  # Молжаниновский район included


def test_confirmed_healthcare_has_wgs84_points_and_map_search_links():
    rows = _rows()
    for row in rows:
        assert 55.7 < float(row["latitude"]) < 56.0
        assert 37.2 < float(row["longitude"]) < 37.7
        assert "yandex.ru/maps/" in row["yandex_maps_search"]
        assert "2gis.ru/" in row["2gis_search"]
        assert "google.com/maps/" in row["google_maps_search"]
    data = json.loads(Path("outputs/sao_state_healthcare_confirmed_wgs84.geojson").read_text(encoding="utf-8"))
    assert data["metadata"]["record_count"] == len(rows) == len(data["features"])
    assert data["metadata"]["coordinate_system"] == "WGS84 / EPSG:4326"


def test_published_map_manifest_includes_confirmed_healthcare_bundle():
    project_dir = Path(__file__).resolve().parents[1]
    map_dir = project_dir.parents[1] / "odh-map"
    manifest = json.loads((map_dir / "layers.json").read_text(encoding="utf-8"))

    healthcare = next(layer for layer in manifest["layers"] if layer["key"] == "healthcare")
    assert healthcare["name"] == "Государственные учреждения здравоохранения (10 подтверждено)"
    assert healthcare["url"] == "layers/sao_state_healthcare_confirmed_wgs84.geojson"

    bundled = json.loads((map_dir / healthcare["url"]).read_text(encoding="utf-8"))
    rows = _rows()
    assert bundled["metadata"]["record_count"] == len(rows) == len(bundled["features"])
    assert {feature["properties"]["address"] for feature in bundled["features"]} == {
        row["address"] for row in rows
    }
    assert all(
        feature["properties"]["verification_status"].startswith("подтверждено официальным сайтом")
        and feature["properties"]["official_source"].startswith("https://")
        for feature in bundled["features"]
    )
