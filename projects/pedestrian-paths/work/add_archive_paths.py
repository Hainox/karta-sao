# -*- coding: utf-8 -*-
"""Добавляет в готовый слой дорожек исторические изолированные пути.

Старый слой «Тропинки» содержит объекты, которых уже нет в текущей выгрузке
АСУ. Если такой путь не покрыт текущими полигонами, он добавляется только для
отображения (источник «Тропинки · архив»). Точки съёмки для него не создаются:
их уже построил prepare_layer.py по текущей выгрузке.

Запускать после prepare_layer.py, иначе архивные пути получат точки.

  python add_archive_paths.py \
    --assets photo-service/assets/pedestrian-paths \
    --existing districts/layers
"""
import argparse
import json
from collections import Counter
from pathlib import Path

from shapely.geometry import shape
from shapely.ops import unary_union
from shapely.prepared import prep
from shapely.strtree import STRtree

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
NAMES = set(SLUGS.values())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets", default=str(ROOT / "photo-service" / "assets" / "pedestrian-paths"))
    parser.add_argument("--existing", default=str(ROOT / "districts" / "layers"))
    parser.add_argument("--source-label", default="Тропинки · архив")
    args = parser.parse_args()

    assets = Path(args.assets)
    existing = {}
    for path in Path(args.existing).glob("*/paths.geojson"):
        for feature in json.loads(path.read_text(encoding="utf-8"))["features"]:
            existing[feature["properties"]["id"]] = feature

    current = {}
    by_slug = {}
    for path in sorted(assets.glob("*.geojson")):
        if path.name == "points.geojson":
            continue
        features = json.loads(path.read_text(encoding="utf-8"))["features"]
        by_slug[path.stem] = features
        for feature in features:
            current[feature["properties"]["id"]] = feature

    extra_ids = set(existing) - set(current)
    if not extra_ids:
        print("archive paths already added")
        return

    current_items = list(current.values())
    current_geoms = [shape(f["geometry"]).buffer(0) for f in current_items]
    tree = STRtree(current_geoms)
    fill_ids = []
    for object_id in extra_ids:
        geom = shape(existing[object_id]["geometry"]).buffer(0)
        candidates = tree.query(geom.buffer(0.0005))
        if len(candidates) == 0:
            fill_ids.append(object_id)
            continue
        union = unary_union([current_geoms[int(index)] for index in candidates])
        ratio = geom.intersection(union).area / geom.area if geom.area else 0
        if ratio < 0.5:
            fill_ids.append(object_id)

    boundary_data = json.loads((ROOT / "districts.geojson").read_text(encoding="utf-8"))
    boundaries = [(f["properties"]["district"], shape(f["geometry"])) for f in boundary_data["features"]]

    def assign_district(geom):
        centroid = geom.centroid
        for name, boundary in boundaries:
            if prep(boundary).covers(centroid):
                return name
        return min(boundaries, key=lambda item: item[1].distance(centroid))[0]

    added = Counter()
    for object_id in fill_ids:
        feature = existing[object_id]
        props = feature["properties"]
        district = props.get("district")
        if district not in NAMES:
            district = assign_district(shape(feature["geometry"]).buffer(0))
        normalized = {
            **props,
            "district": district,
            "type": props.get("object_type_name"),
            "yard": props.get("parent_object_name"),
            "coating": props.get("coating_type_name") or "",
            "area": props.get("total_area"),
            "status": props.get("object_status_name"),
            "source": args.source_label,
            "source_id": str(object_id),
            "archive_source": "Тропинки",
        }
        slug = next(slug for slug, name in SLUGS.items() if name == district)
        by_slug[slug].append({"type": "Feature", "geometry": feature["geometry"], "properties": normalized})
        added[district] += 1

    for slug, name in SLUGS.items():
        path = assets / f"{slug}.geojson"
        path.write_text(json.dumps(
            {"type": "FeatureCollection", "name": f"peshehodnye_dorozhki_{slug}", "features": by_slug[slug]},
            ensure_ascii=False), encoding="utf-8")

    print("archive paths added", len(fill_ids), "by district", added.most_common())
    print("layer total", sum(len(v) for v in by_slug.values()))


if __name__ == "__main__":
    main()
