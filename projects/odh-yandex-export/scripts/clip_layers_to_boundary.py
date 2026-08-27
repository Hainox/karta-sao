#!/usr/bin/env python3
"""Clip ODH line/polygon layers to the SAO boundary so no geometry renders
outside the district on the map (no visual "tails").

Registry geometry from reestr-ogh.mos.ru is official and is left untouched
everywhere else in the project; this script only trims the *display* copies
used by odh-map/layers/ so a road that legitimately crosses the OSM-derived
boundary line (interchange ramps, edge-of-district spurs, etc.) doesn't draw
past the purple boundary outline.

Usage:
    python3 scripts/clip_layers_to_boundary.py --layers-dir ../../odh-map/layers

Run this once after any fresh export of sao_wave1_complete_wgs84.geojson /
sao_remaining_wgs84.geojson (or add it as a step in the export pipeline) --
a plain re-export from the registry will reintroduce the same boundary
crossings since they come from real coordinate differences between the OSM
boundary relation and the mos.ru registry, not from a one-off mistake.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from shapely.geometry import shape, mapping
from shapely.ops import unary_union
from shapely.geometry.base import BaseGeometry

LINE_TYPES = {"LineString", "MultiLineString"}
POLY_TYPES = {"Polygon", "MultiPolygon"}

DEFAULT_TARGETS = ("sao_wave1_complete_wgs84.geojson", "sao_remaining_wgs84.geojson")


def load_boundary(layers_dir: Path) -> BaseGeometry:
    fc = json.loads((layers_dir / "sao_boundary_wgs84.geojson").read_text(encoding="utf-8"))
    polys = [shape(f["geometry"]) for f in fc["features"] if f["geometry"]["type"] in POLY_TYPES]
    return unary_union(polys).buffer(0)


def keep_matching_parts(geom: BaseGeometry, want_line: bool) -> BaseGeometry | None:
    """From a (possibly mixed) intersection result, keep only parts of the
    same family as the input and drop stray points/slivers."""
    if geom.is_empty:
        return None
    wanted = LINE_TYPES if want_line else POLY_TYPES
    if geom.geom_type in wanted:
        return geom
    if geom.geom_type == "GeometryCollection":
        parts = [g for g in geom.geoms if g.geom_type in wanted and not g.is_empty]
        if not parts:
            return None
        merged = unary_union(parts)
        return merged if not merged.is_empty else None
    return None


def clip_layer(path: Path, boundary: BaseGeometry) -> dict:
    fc = json.loads(path.read_text(encoding="utf-8"))
    kept = trimmed = dropped = 0
    trimmed_names: list[str] = []
    dropped_names: list[str] = []
    new_features = []
    for feature in fc["features"]:
        geometry = feature.get("geometry")
        if not geometry:
            new_features.append(feature)
            continue
        g = shape(geometry)
        if g.geom_type == "Point" or g.is_empty:
            new_features.append(feature)
            kept += 1
            continue
        if not g.is_valid:
            g = g.buffer(0)
        # Only touch geometry that actually pokes outside the boundary. GEOS's
        # intersection() re-nodes/re-orders vertices even for a fully-contained
        # geometry, which would otherwise dirty every feature's coordinates for
        # no visual change and blow up the diff. difference() is the cheap,
        # side-effect-free "does this need clipping at all?" check.
        outside = g.difference(boundary)
        outside_area = outside.area if outside.geom_type in POLY_TYPES.union({"GeometryCollection"}) else 0.0
        outside_len = outside.length if outside.geom_type in LINE_TYPES.union({"GeometryCollection"}) else 0.0
        needs_clip = outside_area > 1e-12 or outside_len > 1e-8
        if not needs_clip:
            kept += 1
            new_features.append(feature)  # untouched, byte-identical geometry
            continue
        want_line = g.geom_type in LINE_TYPES
        clipped = keep_matching_parts(g.intersection(boundary), want_line)
        name = (feature.get("properties") or {}).get("name")
        if clipped is None:
            dropped += 1
            dropped_names.append(name)
            continue
        trimmed += 1
        trimmed_names.append(name)
        feature = dict(feature)
        feature["geometry"] = mapping(clipped)
        new_features.append(feature)
    fc["features"] = new_features
    # Match the source files' formatting exactly (indent=2, CRLF line endings,
    # no trailing newline) so the git diff only shows features that actually
    # changed, not a whole-file reformat.
    text = json.dumps(fc, ensure_ascii=False, indent=2).replace("\n", "\r\n")
    path.write_bytes(text.encode("utf-8"))
    return {"kept": kept, "trimmed": trimmed, "dropped": dropped,
            "trimmed_names": trimmed_names, "dropped_names": dropped_names}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--layers-dir", type=Path, required=True,
                         help="Directory holding sao_boundary_wgs84.geojson and the layers to clip")
    parser.add_argument("--targets", nargs="*", default=list(DEFAULT_TARGETS),
                         help="Filenames (inside --layers-dir) to clip; default: wave1 + remaining ODH layers")
    args = parser.parse_args()

    boundary = load_boundary(args.layers_dir)
    for filename in args.targets:
        path = args.layers_dir / filename
        if not path.exists():
            print(f"skip (not found): {path}")
            continue
        result = clip_layer(path, boundary)
        print(f"=== {filename} ===")
        print(f"kept unchanged: {result['kept']}, trimmed: {result['trimmed']}, "
              f"dropped (fully outside boundary): {result['dropped']}")
        if result["trimmed_names"]:
            print("trimmed:", result["trimmed_names"])
        if result["dropped_names"]:
            print("dropped:", result["dropped_names"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
