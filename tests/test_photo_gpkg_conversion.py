import importlib.util
import json
import struct
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "work" / "convert_photo_points_gpkg.py"
SPEC = importlib.util.spec_from_file_location("photo_gpkg_converter", MODULE_PATH)
assert SPEC and SPEC.loader
CONVERTER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CONVERTER)


def gpkg_point(x, y, srs_id=3395):
    # GeoPackageBinary header (no envelope), followed by little-endian WKB POINT.
    return b"GP" + bytes([0, 1]) + struct.pack("<i", srs_id) + bytes([1]) + struct.pack("<I", 1) + struct.pack("<dd", x, y)


def test_gpkg_epsg3395_point_transforms_to_sao_wgs84():
    lon, lat = CONVERTER.decode_gpkg_point(gpkg_point(4178268.173, 7498229.114), 3395)
    assert lon == pytest.approx(37.5340216, abs=1e-6)
    assert lat == pytest.approx(55.8752893, abs=1e-6)


def test_gpkg_srs_mismatch_fails_closed():
    with pytest.raises(ValueError, match="Expected EPSG:3395"):
        CONVERTER.decode_gpkg_point(gpkg_point(4178268.173, 7498229.114, srs_id=3857), 3395)


def test_district_assignment_uses_exact_source_polygons():
    districts = json.loads((ROOT / "districts.geojson").read_text(encoding="utf-8"))["features"]
    assert CONVERTER.district_for((37.5340216, 55.8752893), districts) == "Дмитровский"


def test_outside_or_ambiguous_point_is_not_silently_assigned():
    districts = json.loads((ROOT / "districts.geojson").read_text(encoding="utf-8"))["features"]
    with pytest.raises(ValueError, match="maps to no district"):
        CONVERTER.district_for((0.0, 0.0), districts)
