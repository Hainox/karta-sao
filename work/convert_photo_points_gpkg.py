"""Convert photo-point GPKGs (EPSG:3395, azimuth) into an import GeoJSON.

The input files are kept untouched. Points are assigned to exactly one district
from districts.geojson; ambiguous/outside points fail closed instead of being
silently assigned. Azimuth is preserved as clockwise degrees from north.
"""
from __future__ import annotations

import argparse
import json
import math
import pathlib
import sqlite3
import struct
import sys

from pyproj import Transformer

ROOT = pathlib.Path(__file__).resolve().parents[1]
DISTRICTS_PATH = ROOT / "districts.geojson"
TRANSFORMERS = {
    3395: Transformer.from_crs("EPSG:3395", "EPSG:4326", always_xy=True),
    3857: Transformer.from_crs("EPSG:3857", "EPSG:4326", always_xy=True),
}
SOURCE_NAMES = {
    "Коровинское ш., Бескудниковский бул..gpkg": "Коровинское ш. — Бескудниковский бул.",
    "800 летия.gpkg": "800-летия Москвы",
    "Ангарская улица.gpkg": "Ангарская ул.",
}


def point_in_ring(point: tuple[float, float], ring: list[list[float]]) -> bool:
    x, y = point
    inside = False
    for i, (x1, y1) in enumerate(ring):
        x2, y2 = ring[(i + 1) % len(ring)]
        if (y1 > y) != (y2 > y):
            crossing = (x2 - x1) * (y - y1) / (y2 - y1) + x1
            if x < crossing:
                inside = not inside
    return inside


def district_for(point: tuple[float, float], districts: list[dict]) -> str:
    matches = []
    for feature in districts:
        geometry = feature["geometry"]
        polygons = geometry["coordinates"] if geometry["type"] == "MultiPolygon" else [geometry["coordinates"]]
        for polygon in polygons:
            if point_in_ring(point, polygon[0]) and all(not point_in_ring(point, hole) for hole in polygon[1:]):
                matches.append(feature["properties"]["district"])
                break
    if len(matches) != 1:
        raise ValueError(f"Point {point} maps to {matches or 'no district'}; stop for manual review")
    return matches[0]


def decode_gpkg_point(blob: bytes, expected_srs: int) -> tuple[float, float]:
    if blob[:2] != b"GP":
        raise ValueError("Geometry is not GeoPackageBinary")
    flags = blob[3]
    if flags & 0x10:
        raise ValueError("Empty geometry")
    little = bool(flags & 0x01)
    byte_order = "<" if little else ">"
    srs_id = struct.unpack(byte_order + "i", blob[4:8])[0]
    if srs_id != expected_srs:
        raise ValueError(f"Expected EPSG:{expected_srs}, got EPSG:{srs_id}")
    envelope_code = (flags >> 1) & 0x07
    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    if envelope_code not in envelope_sizes:
        raise ValueError(f"Unknown GeoPackage envelope code {envelope_code}")
    offset = 8 + envelope_sizes[envelope_code]
    wkb_little = blob[offset] == 1
    wkb_order = "<" if wkb_little else ">"
    geometry_type = struct.unpack(wkb_order + "I", blob[offset + 1:offset + 5])[0] & 0xFF
    if geometry_type != 1:
        raise ValueError(f"Expected POINT WKB, got type {geometry_type}")
    x, y = struct.unpack(wkb_order + "dd", blob[offset + 5:offset + 21])
    lon, lat = TRANSFORMERS[srs_id].transform(x, y)
    if not (math.isfinite(lon) and math.isfinite(lat) and -180 <= lon <= 180 and -90 <= lat <= 90):
        raise ValueError(f"Converted coordinate outside WGS84: {(lon, lat)}")
    return round(lon, 7), round(lat, 7)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True)
    parser.add_argument("files", nargs="+", help="three source GeoPackages")
    args = parser.parse_args()
    districts = json.loads(DISTRICTS_PATH.read_text(encoding="utf-8"))["features"]
    features = []
    seen_source_keys = set()

    for source_value in args.files:
        source = pathlib.Path(source_value)
        if source.name not in SOURCE_NAMES:
            raise ValueError(f"Unexpected GPKG filename; add an explicit short name mapping: {source.name}")
        source_short = SOURCE_NAMES[source.name]
        connection = sqlite3.connect(f"file:{source.resolve().as_posix()}?mode=ro", uri=True)
        try:
            table_row = connection.execute(
                "SELECT table_name, srs_id FROM gpkg_contents WHERE data_type = 'features'"
            ).fetchall()
            if len(table_row) != 1:
                raise ValueError(f"Expected one feature layer in {source.name}, found {len(table_row)}")
            table, srs_id = table_row[0]
            if srs_id not in TRANSFORMERS:
                raise ValueError(f"Unsupported CRS EPSG:{srs_id} in {source.name}")
            columns = {row[1] for row in connection.execute(f'PRAGMA table_info("{table}")')}
            if not {"fid", "geom", "azimuth"}.issubset(columns):
                raise ValueError(f"Expected fid, geom, azimuth fields in {source.name}")
            rows = connection.execute(f'SELECT fid, geom, azimuth FROM "{table}" ORDER BY fid').fetchall()
            for fid, geometry, azimuth in rows:
                if azimuth is None or not math.isfinite(float(azimuth)) or not 0 <= float(azimuth) < 360:
                    raise ValueError(f"Invalid azimuth in {source.name}, fid={fid}: {azimuth}")
                source_key = f"{source.name}:{fid}"
                if source_key in seen_source_keys:
                    raise ValueError(f"Duplicate source key {source_key}")
                seen_source_keys.add(source_key)
                longitude, latitude = decode_gpkg_point(geometry, srs_id)
                district = district_for((longitude, latitude), districts)
                label = f"{source_short} · {int(fid):03d}"
                note = (
                    f"Источник: {source.name}; слой «{table}»; fid={fid}; "
                    f"CRS исходника EPSG:{srs_id}; азимут исходника {float(azimuth):.5f}°. "
                    "Импортированы как отдельная точка съёмки; исходный GPKG сохранён без изменений."
                )
                features.append({
                    "type": "Feature",
                    "id": source_key,
                    "properties": {
                        "district": district,
                        "label": label,
                        "heading": round(float(azimuth), 5),
                        "note": note,
                        "source_file": source.name,
                        "source_layer": table,
                        "source_fid": int(fid),
                        "source_crs": f"EPSG:{srs_id}",
                    },
                    "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
                })
            print(f"{source.name}: {len(rows)} points, EPSG:{srs_id}")
        finally:
            connection.close()

    output = {
        "type": "FeatureCollection",
        "name": "district-photo-points-gpkg-import-2026-10-22",
        "metadata": {
            "purpose": "Existing GPKG points/arrows imported as editable photo assignments",
            "coordinate_conversion": "EPSG:3395 -> EPSG:4326 via pyproj",
            "photo_attachments_in_sources": False,
            "feature_count": len(features),
        },
        "features": features,
    }
    destination = pathlib.Path(args.output)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    temporary.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(destination)
    print(f"Wrote {len(features)} features to {destination}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"STOPPED: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
