# -*- coding: utf-8 -*-
"""Собирает слой пешеходных дорожек из двух выгрузок АСУ ОДС.

parent_type_id = 38 — улицы и дворы, parent_type_id = 40 — скверы, бульвары,
парки. На вход подаются списки объектов (JSONL или каталог страниц) и каталоги
геометрии `/ogh/geometry/load`; на выходе — 16 файлов по районам.

  python build_layer.py \
    --parent38-jsonl asu-dts-all.jsonl --parent38-geom asu-geom \
    --parent40-pages asu-dts-pages-40 --parent40-geom asu-geom-40 \
    --out merged
"""
import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from pyproj import Transformer
from shapely.geometry import shape
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[3]

SLUGS = {
    "aeroport": "Аэропорт", "begovoy": "Беговой", "beskudnikovskiy": "Бескудниковский",
    "voykovskiy": "Войковский", "vostochnoe-degunino": "Восточное Дегунино",
    "golovinskiy": "Головинский", "dmitrovskiy": "Дмитровский",
    "zapadnoe-degunino": "Западное Дегунино", "koptevo": "Коптево",
    "levoberezhnyy": "Левобережный", "molzhaninovskiy": "Молжаниновский",
    "savelovskiy": "Савеловский", "sokol": "Сокол", "timiryazevskiy": "Тимирязевский",
    "hovrino": "Ховрино", "horoshevskiy": "Хорошевский",
}
NAME_TO_SLUG = {name: slug for slug, name in SLUGS.items()}

MSK77 = ("+proj=tmerc +ellps=bessel +towgs84=367.93,88.45,553.73,"
         "-0.8777,1.3231,2.6248,8.96 +units=m +lon_0=37.5 "
         "+lat_0=55.66666666667 +k_0=1 +x_0=0 +y_0=0")
TO_DEG = Transformer.from_crs(MSK77, "EPSG:4326", always_xy=True)


def load_rows(source_dir, jsonl=None):
    if jsonl:
        rows = [json.loads(line) for line in jsonl.read_text(encoding="utf-8").splitlines() if line.strip()]
    else:
        rows = []
        for path in sorted(source_dir.glob("page_*.json")):
            rows.extend(json.loads(path.read_text(encoding="utf-8")))
    return {row["id"]: row for row in rows if row.get("id") and row.get("object_type_name") == "Пешеходная дорожка"}


def load_geometry(source_dir):
    geometry = {}
    for path in sorted(source_dir.glob("geom_*.json")):
        for item in json.loads(path.read_text(encoding="utf-8")):
            geometry[item["id"]] = item
    return geometry


def project(ring):
    result = []
    for point in ring:
        if not isinstance(point, (list, tuple)) or len(point) < 2:
            continue
        lon, lat = TO_DEG.transform(point[0], point[1])
        result.append([round(lon, 7), round(lat, 7)])
    return result


def close_ring(ring):
    if len(ring) >= 3 and ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring


def build_geometry(item):
    polygons = []
    for polygon in item.get("polygons") or []:
        rings = [close_ring(project(ring)) for ring in polygon.get("coordinates") or []]
        rings = [ring for ring in rings if len(ring) >= 4]
        if rings:
            polygons.append(rings)
    if not polygons:
        return None
    return ({"type": "Polygon", "coordinates": polygons[0]} if len(polygons) == 1
            else {"type": "MultiPolygon", "coordinates": polygons})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--parent38-jsonl", required=True)
    parser.add_argument("--parent38-geom", required=True)
    parser.add_argument("--parent40-pages", required=True)
    parser.add_argument("--parent40-geom", required=True)
    parser.add_argument("--existing", default=str(ROOT / "districts" / "layers"))
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    existing_district = {}
    for path in sorted(Path(args.existing).glob("*/paths.geojson")):
        if path.parent.name == "unassigned":
            continue
        for feature in json.loads(path.read_text(encoding="utf-8"))["features"]:
            district = feature["properties"].get("district")
            if district in NAME_TO_SLUG:
                existing_district[feature["properties"]["id"]] = district

    boundary_data = json.loads((ROOT / "districts.geojson").read_text(encoding="utf-8"))
    boundaries = [(f["properties"]["district"], prep(shape(f["geometry"]))) for f in boundary_data["features"]]
    boundary_shapes = [(f["properties"]["district"], shape(f["geometry"])) for f in boundary_data["features"]]

    def assign_district(geom):
        centroid = geom.centroid
        for name, prepared in boundaries:
            if prepared.covers(centroid):
                return name
        # Вода/дырка в границах: ближайший район, чтобы объект не потерялся.
        return min(boundary_shapes, key=lambda item: item[1].distance(centroid))[0]

    parent38_rows = load_rows(None, Path(args.parent38_jsonl))
    parent38_geom = load_geometry(Path(args.parent38_geom))
    parent40_rows = load_rows(Path(args.parent40_pages))
    parent40_geom = load_geometry(Path(args.parent40_geom))
    print("parent38 paths", len(parent38_rows), "geometry", len(parent38_geom))
    print("parent40 paths", len(parent40_rows), "geometry", len(parent40_geom))

    rows = {}
    rows.update(parent40_rows)
    rows.update(parent38_rows)  # при совпадении id приоритет у улиц/дворов
    geometry = {}
    geometry.update(parent40_geom)
    geometry.update(parent38_geom)
    print("combined unique paths", len(rows))

    features = []
    missing = 0
    for object_id, row in rows.items():
        item = geometry.get(object_id)
        if not item:
            missing += 1
            continue
        geom = build_geometry(item)
        if not geom:
            missing += 1
            continue
        district = existing_district.get(object_id)
        if district not in NAME_TO_SLUG:
            district = assign_district(shape(geom))
        props = {
            "id": object_id,
            "ogh_id": row.get("short_root_id") or row.get("root_id"),
            "type": row.get("object_type_name"),
            "yard": row.get("parent_object_name"),
            "district": district,
            "coating": row.get("coating_type_name"),
            "area": row.get("total_area"),
            "status": row.get("object_status_name"),
            "parent_type_id": row.get("parent_type_id"),
            "object_type_name": "Пешеходная дорожка",
            "coating_type_name": row.get("coating_type_name") or "",
            "parent_object_name": row.get("parent_object_name") or "",
            "object_status_name": row.get("object_status_name") or "",
            "source": "АСУ ОДС",
            "source_id": str(object_id),
        }
        if row.get("total_area") is not None:
            props["total_area"] = row.get("total_area")
        features.append({"type": "Feature", "geometry": geom, "properties": props})

    print("features", len(features), "missing geometry", missing)
    print("by parent_type", Counter(f["properties"]["parent_type_id"] for f in features).most_common())

    by_district = defaultdict(list)
    for feature in features:
        by_district[feature["properties"]["district"]].append(feature)
    for slug, name in SLUGS.items():
        subset = by_district.get(name, [])
        (out / f"{slug}.geojson").write_text(json.dumps(
            {"type": "FeatureCollection", "name": f"peshehodnye_dorozhki_{slug}", "features": subset},
            ensure_ascii=False), encoding="utf-8")
        print(f"  {slug:24} {len(subset):5}")

    print("written to", out)


if __name__ == "__main__":
    main()
