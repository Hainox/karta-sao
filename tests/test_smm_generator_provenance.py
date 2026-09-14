import json
from pathlib import Path

from work.build_smm_print_a3 import build as build_print
from work.build_smm_routes_overlay import build as build_routes


ROOT = Path(__file__).resolve().parents[1]


def features_by_variant(data, variant_id, feature_kind):
    return [
        feature
        for feature in data["features"]
        if feature["properties"].get("variant_id") == variant_id
        and feature["properties"].get("feature_kind") == feature_kind
    ]


def test_current_smm_sources_and_print_claims_are_qualified(tmp_path):
    routes_path = tmp_path / "smm_routes.geojson"
    print_path = tmp_path / "print-a3.html"
    build_routes(ROOT / "smm.geojson", routes_path, ROOT / "work" / "smm_tracks")
    routes = json.loads(routes_path.read_text(encoding="utf-8"))

    for variant in ("dt1", "dt2", "dt3"):
        route = features_by_variant(routes, variant, "route_direction")[0]
        nozzle = features_by_variant(routes, variant, "nozzle_direction")[0]
        assert route["properties"]["route_origin"] == "inner_yard_reference"
        assert route["properties"]["source"] == "reference_scheme"
        assert nozzle["properties"]["nozzle_origin"] == "inner_yard_reference"
        assert nozzle["properties"]["source"] == "reference_scheme"

    for variant in ("dt4", "dt5"):
        route = features_by_variant(routes, variant, "route_direction")[0]
        nozzle = features_by_variant(routes, variant, "nozzle_direction")[0]
        assert route["properties"]["route_origin"] == "yard_route"
        assert route["properties"]["source"] == "yard_route"
        assert "требует полевой сверки" in route["properties"]["status"].lower()
        assert "gps-трек" not in route["properties"]["status"].lower()
        assert route["properties"]["bearing"] is None
        assert route["properties"]["movement_mode"] == "multidirectional"
        assert nozzle["properties"]["nozzle_origin"] == "yard_route"
        assert "проектные направления" in nozzle["properties"]["status"].lower()
        assert "замер направлений" not in nozzle["properties"]["status"].lower()

    build_print(
        print_path,
        ROOT / "smm.geojson",
        routes_path,
        ROOT / "smm",
        ROOT / "sao-coa.png",
    )
    markup = print_path.read_text(encoding="utf-8")
    assert "Геометрия:</b> Планировочная привязка по адресу; требует натурной сверки и утверждения" in markup
    assert "OpenStreetMap, предварительная привязка" in markup
    assert "Многовекторный маршрут" in markup
    assert "0.0° · север" not in markup
    assert "GPS-трек (17 точек): фактический маршрут" not in markup
    assert "Замер направлений выброса: 17 точек" not in markup


def test_gpx_track_segments_are_emitted_as_independent_lines(tmp_path):
    tracks_dir = tmp_path / "tracks"
    tracks_dir.mkdir()
    (tracks_dir / "dt1.gpx").write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <trkseg>
      <trkpt lat="55.79450" lon="37.51200"/>
      <trkpt lat="55.79450" lon="37.51240"/>
    </trkseg>
    <trkseg>
      <trkpt lat="55.79470" lon="37.51280"/>
      <trkpt lat="55.79470" lon="37.51300"/>
    </trkseg>
  </trk>
</gpx>
""",
        encoding="utf-8",
    )
    out_path = tmp_path / "routes.geojson"

    build_routes(ROOT / "smm.geojson", out_path, tracks_dir)
    data = json.loads(out_path.read_text(encoding="utf-8"))
    route_features = features_by_variant(data, "dt1", "route_direction")

    assert len(route_features) == 2
    assert [feature["properties"]["track_segment"] for feature in route_features] == [1, 2]
    assert all(feature["properties"]["track_segments"] == 2 for feature in route_features)
    assert route_features[0]["geometry"]["coordinates"] == [[37.512, 55.7945], [37.5124, 55.7945]]
    assert route_features[1]["geometry"]["coordinates"] == [[37.5128, 55.7947], [37.513, 55.7947]]
    assert all(feature["properties"]["route_origin"] == "unverified" for feature in route_features)
    assert all(feature["properties"]["source"] == "unverified" for feature in route_features)
    assert all("источник не указан" in feature["properties"]["status"].lower() for feature in route_features)


def test_gps_status_requires_explicit_provenance(tmp_path):
    tracks_dir = tmp_path / "tracks"
    tracks_dir.mkdir()
    (tracks_dir / "dt1.gpx").write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="gnss" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><trkseg>
    <trkpt lat="55.79450" lon="37.51200"/>
    <trkpt lat="55.79450" lon="37.51240"/>
  </trkseg></trk>
</gpx>
""",
        encoding="utf-8",
    )
    (tracks_dir / "dt1.nozzle.json").write_text(
        json.dumps({"route_source_kind": "gps", "nozzle_source_kind": "measurement", "points": []}),
        encoding="utf-8",
    )
    out_path = tmp_path / "routes.geojson"

    build_routes(ROOT / "smm.geojson", out_path, tracks_dir)
    data = json.loads(out_path.read_text(encoding="utf-8"))
    route = features_by_variant(data, "dt1", "route_direction")[0]

    assert route["properties"]["route_origin"] == "gps"
    assert route["properties"]["source"] == "gpx"
    assert "GPS-трек" in route["properties"]["status"]
