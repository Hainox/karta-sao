# -*- coding: utf-8 -*-
"""Рейтинг самых проходных дорожек и разметка их точек съёмки.

Считает близость к метро/остановкам, число подъездов с учётом этажности,
магазины, школы и медучреждения. Отбирает 20–39 дорожек на район с
прореживанием по сетке 500 м и шагом 35 м.

Вход `--osm` — JSON-массив точек OpenStreetMap вида
[{"kind": "metro|bus|tram|rail|education|health|shop|service", "lon": ..., "lat": ...}].
Его можно получить запросом Overpass:
  [out:json][timeout:240];
  (
    node["railway"="subway_entrance"](55.70,37.35,55.95,37.65);
    node["station"="subway"](55.70,37.35,55.95,37.65);
    node["railway"="station"](55.70,37.35,55.95,37.65);
    node["highway"="bus_stop"](55.70,37.35,55.95,37.65);
    node["railway"="tram_stop"](55.70,37.35,55.95,37.65);
    node["amenity"~"school|kindergarten|hospital|clinic|college|university"](55.70,37.35,55.95,37.65);
    node["shop"](55.70,37.35,55.95,37.65);
    node["amenity"~"cafe|restaurant|bank|pharmacy"](55.70,37.35,55.95,37.65);
  );
  out center tags;

  python rank_popular_paths.py --osm osm-poi.json --summary summary.json [--apply]
"""
import argparse
import json
import math
from collections import defaultdict
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[3]


def load_entrances(root):
    points = []
    for path in sorted(Path(root).glob("*/entrances.geojson")):
        for feature in json.loads(path.read_text(encoding="utf-8"))["features"]:
            coordinates = feature.get("geometry", {}).get("coordinates")
            if coordinates and len(coordinates) >= 2:
                points.append((Point(coordinates[0], coordinates[1]), feature.get("properties") or {}))
    return points


def score_path(path, entrance_tree, entrance_points, poi_trees, poi_groups):
    def nearest(tree, points):
        best = 9999.0
        for index in tree.query(path.buffer(0.006)):
            best = min(best, path.distance(points[int(index)]))
        return best

    def count_near(tree, radius):
        count = 0
        for index in tree.query(path.buffer(radius)):
            if path.distance(tree.geometries[int(index)]) <= radius:
                count += 1
        return count

    entrances = 0.0
    for index in entrance_tree.query(path.buffer(0.0015)):
        if path.distance(entrance_points[int(index)][0]) <= 0.0015:
            try:
                floors = int(entrance_points[int(index)][1].get("floors") or 5)
            except (TypeError, ValueError):
                floors = 5
            entrances += 1.0 + min(floors, 25) / 20.0

    metro_d = nearest(poi_trees["metro"], poi_groups["metro"])
    bus_d = nearest(poi_trees["bus"], poi_groups["bus"])
    tram_d = nearest(poi_trees["tram"], poi_groups["tram"])
    shops = count_near(poi_trees["shop"], 0.0013)
    amenities = count_near(poi_trees["amenity"], 0.002)

    score = 35 * math.exp(-metro_d / 120) + 12 * math.exp(-bus_d / 90)
    score += 4 * math.log1p(entrances)
    score += 2 * math.log1p(shops)
    score += 1.5 * math.log1p(amenities)
    if tram_d < 150:
        score += 4 * math.exp(-tram_d / 100)
    if metro_d < 150 and bus_d < 100:
        score += 6
    return score, {
        "metro_d": round(metro_d, 1), "bus_d": round(bus_d, 1), "tram_d": round(tram_d, 1),
        "entrances": round(entrances, 2), "shops": shops, "amenities": amenities,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", default=str(ROOT / "photo-service" / "assets" / "pedestrian-paths"))
    parser.add_argument("--entrances", default=str(ROOT / "districts" / "layers"))
    parser.add_argument("--osm", required=True)
    parser.add_argument("--summary", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    entrance_points = load_entrances(args.entrances)
    entrance_tree = STRtree([point for point, _ in entrance_points])
    pois = json.loads(Path(args.osm).read_text(encoding="utf-8"))
    groups = defaultdict(list)
    for poi in pois:
        groups[poi["kind"]].append(Point(poi["lon"], poi["lat"]))
    groups["metro"] = groups["metro"] + groups["rail"]
    groups["amenity"] = groups["education"] + groups["health"] + groups["service"]
    poi_trees = {key: STRtree(value) for key, value in groups.items()}
    print("entrances", len(entrance_points), "pois", {key: len(value) for key, value in groups.items()})

    districts = defaultdict(list)
    assets = Path(args.assets)
    for file in sorted(assets.glob("*.geojson")):
        if file.name == "points.geojson":
            continue
        for feature in json.loads(file.read_text(encoding="utf-8"))["features"]:
            props = feature["properties"]
            if props.get("archive_source"):
                continue
            geom = shape(feature["geometry"]).buffer(0)
            score, parts = score_path(geom, entrance_tree, entrance_points, poi_trees, groups)
            area = geom.area * 111000 * 111320 * math.cos(math.radians(geom.centroid.y))
            districts[props["district"]].append({
                "id": props["id"], "address": props.get("yard") or "", "area": area,
                "score": score, "parts": parts, "geom": geom, "centroid": geom.centroid,
            })

    summary = []
    for district, items in sorted(districts.items()):
        candidates = [item for item in items if item["area"] >= 5]
        candidates.sort(key=lambda item: item["score"], reverse=True)
        limit = max(20, min(45, round(len(candidates) * 0.035)))
        selected = []
        cells = {}
        for item in candidates:
            if len(selected) >= limit:
                break
            if item["score"] <= 2:
                continue
            cell = (round(item["centroid"].y / 0.0045), round(item["centroid"].x / 0.0045))
            if cells.get(cell, 0) >= 4:
                continue
            if any(item["centroid"].distance(chosen["centroid"]) * 111000 < 35 for chosen in selected):
                continue
            selected.append(item)
            cells[cell] = cells.get(cell, 0) + 1
        if len(selected) < limit:
            chosen_ids = {item["id"] for item in selected}
            for item in candidates:
                if len(selected) >= limit:
                    break
                if item["id"] in chosen_ids or item["score"] <= 2:
                    continue
                if any(item["centroid"].distance(chosen["centroid"]) * 111000 < 35 for chosen in selected):
                    continue
                selected.append(item)
        selected.sort(key=lambda item: item["score"], reverse=True)
        for rank, item in enumerate(selected, start=1):
            summary.append({
                "district": district, "rank": rank, "id": item["id"], "address": item["address"],
                "score": round(item["score"], 2), "area": round(item["area"], 1), "parts": item["parts"],
            })
        print(f"{district}: selected {len(selected)}/{limit}, top {round(selected[0]['score'], 1) if selected else 0}")

    Path(args.summary).write_text(json.dumps(summary, ensure_ascii=False, indent=1), encoding="utf-8")
    print("selected", len(summary), "summary", args.summary)
    if not args.apply:
        return

    by_id = {str(row["id"]): row for row in summary}
    for file in sorted(assets.glob("*.geojson")):
        if file.name == "points.geojson":
            continue
        data = json.loads(file.read_text(encoding="utf-8"))
        for feature in data["features"]:
            props = feature["properties"]
            row = by_id.get(str(props.get("id")))
            props["popular"] = bool(row)
            if row:
                props["popular_rank"] = row["rank"]
                props["popular_score"] = row["score"]
            else:
                props.pop("popular_rank", None)
                props.pop("popular_score", None)
        file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    points = json.loads((assets / "points.geojson").read_text(encoding="utf-8"))
    popular_points = 0
    for feature in points["features"]:
        props = feature["properties"]
        row = by_id.get(str(props.get("path_id")))
        props["popular"] = bool(row)
        if row:
            props["popular_rank"] = row["rank"]
            props["popular_score"] = row["score"]
            popular_points += 1
        else:
            props.pop("popular_rank", None)
            props.pop("popular_score", None)
    (assets / "points.geojson").write_text(json.dumps(points, ensure_ascii=False), encoding="utf-8")
    print("path features", len(by_id), "points", popular_points)


if __name__ == "__main__":
    main()
