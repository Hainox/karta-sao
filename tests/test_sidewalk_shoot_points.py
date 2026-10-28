"""Черновые точки съёмки тротуаров: только у домов внутри дворов, не на ОДХ."""
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
LAYERS = ROOT / "districts" / "layers"
FILES = sorted(LAYERS.glob("*/sidewalk_shoot.geojson"))

shapely = pytest.importorskip("shapely")
from shapely.geometry import Point, shape  # noqa: E402
from shapely.ops import unary_union  # noqa: E402
from shapely.strtree import STRtree  # noqa: E402


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.mark.parametrize("path", FILES, ids=[p.parent.name for p in FILES])
def test_points_sit_on_yard_sidewalks_not_on_odh(path):
    slug_dir = path.parent
    walks = load(slug_dir / "sidewalks.geojson")["features"]
    yard_walks = unary_union([shape(f["geometry"]).buffer(0) for f in walks if f["properties"].get("parent_type_id") == 38])
    yards = STRtree([shape(f["geometry"]).buffer(0.00005) for f in load(slug_dir / "yards.geojson")["features"]])
    roads = STRtree([shape(f["geometry"]) for name in ("driveways", "odh")
                     for f in load(slug_dir / f"{name}.geojson")["features"]])
    features = load(path)["features"]
    assert features
    numbers = [f["properties"]["point_no"] for f in features]
    assert len(numbers) == len(set(numbers))
    tol = 0.00002  # ~1,5 м
    for f in features:
        pt = Point(f["geometry"]["coordinates"])
        p = f["properties"]
        assert yard_walks.distance(pt) < tol, p["point_no"]
        assert len(yards.query(pt, predicate="within")), p["point_no"]
        assert not len(roads.query(pt, predicate="within")), p["point_no"]
        assert 0 <= p["azimuth"] < 360
        assert p["address"]
