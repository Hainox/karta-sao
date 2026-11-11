# -*- coding: utf-8 -*-
"""Готовит слой пешеходных дорожек и точки съёмки для оцифровки.

Вход — GeoJSON по районам из выгрузки АСУ ОДС (properties: id, ogh_id, district,
yard, coating, area, status). Выход:

  <out>/<slug>.geojson        слой для карт районов, с именами свойств, которые
                              понимает карточка объекта;
  <out>/points.geojson        точки съёмки: одна на короткую дорожку, вдоль
                              скелета — на длинную (шаг около 70 м).

Точки ставятся по внешнему кольцу через равные отрезки пути и поднимаются
к гребню расстояний (середине дорожки). Шаг считается по длине кольца, а не
по прямой: извилистая дорожка получает точки вдоль всей трассы, даже если её
ветви проходят близко друг к другу.

  python prepare_layer.py --source "C:\\...\\по_районам" --out ...\\assets\\pedestrian-paths
"""
import argparse
import json
import math
from pathlib import Path

import numpy as np
from pyproj import Transformer
from scipy.ndimage import distance_transform_edt
from shapely import contains_xy
from shapely.geometry import MultiPolygon, Point, Polygon, shape

SLUGS = {
    "aeroport": "Аэропорт", "begovoy": "Беговой", "beskudnikovskiy": "Бескудниковский",
    "voykovskiy": "Войковский", "vostochnoe-degunino": "Восточное Дегунино",
    "golovinskiy": "Головинский", "dmitrovskiy": "Дмитровский",
    "zapadnoe-degunino": "Западное Дегунино", "koptevo": "Коптево",
    "levoberezhnyy": "Левобережный", "molzhaninovskiy": "Молжаниновский",
    "savelovskiy": "Савеловский", "sokol": "Сокол", "timiryazevskiy": "Тимирязевский",
    "hovrino": "Ховрино", "horoshevskiy": "Хорошевский",
}

TO_M = Transformer.from_crs("EPSG:4326", "EPSG:32637", always_xy=True)
TO_DEG = Transformer.from_crs("EPSG:32637", "EPSG:4326", always_xy=True)

STEP = 1.0          # размер клетки растра, м
LONG_ROUTE = 100.0  # с этой длины дорожку снимаем несколькими точками
SPACING = 70.0      # минимальный шаг между точками вдоль трассы, м


def metric(geom):
    """Геометрия в метрах UTM 37N."""
    def ring(coords):
        xs, ys = TO_M.transform([p[0] for p in coords], [p[1] for p in coords])
        return list(zip(xs, ys))

    if isinstance(geom, Polygon):
        return Polygon(ring(geom.exterior.coords), [ring(r.coords) for r in geom.interiors])
    return MultiPolygon([Polygon(ring(p.exterior.coords), [ring(r.coords) for r in p.interiors]) for p in geom.geoms])


def rasterize(geom_m):
    """Маска 1 м по bbox геометрии и координаты её нижнего левого угла."""
    minx, miny, maxx, maxy = geom_m.bounds
    width = max(1, int(math.ceil(maxx - minx)) + 1)
    height = max(1, int(math.ceil(maxy - miny)) + 1)
    xs = minx + np.arange(width) + 0.5
    ys = miny + np.arange(height) + 0.5
    grid_x, grid_y = np.meshgrid(xs, ys)
    parts = [geom_m] if isinstance(geom_m, Polygon) else list(geom_m.geoms)
    mask = np.zeros((height, width), dtype=bool)
    for part in parts:
        mask |= contains_xy(part, grid_x, grid_y)
    return mask, minx, miny


def route_length(geom_m):
    """Длина трассы: половина периметра — у полосы это её осевая длина."""
    if isinstance(geom_m, Polygon):
        return (geom_m.exterior.length + sum(r.length for r in geom_m.interiors)) / 2
    return sum(p.exterior.length + sum(r.length for r in p.interiors) for p in geom_m.geoms) / 2


def ascend(dist, row, col):
    """Поднимает клетку к локальному максимуму расстояния — на гребень дорожки."""
    height, width = dist.shape
    for _ in range(max(height, width)):
        best = (dist[row, col], row, col)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                if not dr and not dc:
                    continue
                r, c = row + dr, col + dc
                if 0 <= r < height and 0 <= c < width and dist[r, c] > best[0]:
                    best = (dist[r, c], r, c)
        if best[1] == row and best[2] == col:
            break
        _, row, col = best
    return row, col


def ridge_points(geom_m):
    """Точки вдоль кольца с подъёмом на гребень: [(x, y), ...] в метрах."""
    mask, minx, miny = rasterize(geom_m)
    if not mask.any():
        return []
    # Рамка из False по краям: без неё distance_transform_edt считает край массива
    # продолжением полигона и гребень липнет к границе bbox.
    padded = np.pad(mask, 1, constant_values=False)
    dist = distance_transform_edt(padded)
    rows, cols = np.nonzero(mask)
    deepest = int(np.argmax(dist[rows + 1, cols + 1]))
    route = route_length(geom_m)
    if route < LONG_ROUTE:
        return [(minx + cols[deepest] + 0.5, miny + rows[deepest] + 0.5)]

    rings = [geom_m.exterior] if isinstance(geom_m, Polygon) else [p.exterior for p in geom_m.geoms]
    picked = []
    for ring in rings:
        length = ring.length
        count = max(1, round((length / 2) / SPACING))
        for index in range(count):
            point = ring.interpolate((index + 0.5) / count, normalized=True)
            col = int(round(point.x - minx - 0.5)) + 1
            row = int(round(point.y - miny - 0.5)) + 1
            row = min(max(row, 0), padded.shape[0] - 1)
            col = min(max(col, 0), padded.shape[1] - 1)
            if not padded[row, col]:
                # Кольцо прошло между клетками растра — берём ближайшую внутреннюю.
                nearest = np.argmin((rows + 1 - row) ** 2 + (cols + 1 - col) ** 2)
                row, col = rows[nearest] + 1, cols[nearest] + 1
            row, col = ascend(dist, row, col)
            x = minx + (col - 1) + 0.5
            y = miny + (row - 1) + 0.5
            if all((x - px) ** 2 + (y - py) ** 2 >= 4 for px, py in picked):
                picked.append((x, y))
    return picked


def along_position(geom_m, x, y):
    """Позиция точки вдоль внешнего кольца — для нумерации по ходу трассы."""
    point = Point(x, y)
    rings = [geom_m.exterior] if isinstance(geom_m, Polygon) else [p.exterior for p in geom_m.geoms]
    return min(ring.project(point) for ring in rings)


def sample(geom, props):
    """Точки съёмки одной дорожки: [(lon, lat, ordinal, route_m)]."""
    geom_m = metric(geom)
    route = route_length(geom_m)
    picked = ridge_points(geom_m)
    if not picked:
        point = geom.representative_point()
        return [(point.x, point.y, 1, route)]
    picked.sort(key=lambda item: along_position(geom_m, *item))
    result = []
    for ordinal, (x, y) in enumerate(picked, start=1):
        lon, lat = TO_DEG.transform(x, y)
        result.append((round(lon, 7), round(lat, 7), ordinal, round(route, 1)))
    return result


def layer_properties(props):
    """Свойства, которые уже умеет показывать карточка объекта на карте района."""
    yard = props.get("yard") or ""
    coating = props.get("coating") or ""
    status = props.get("status") or ""
    area = props.get("area")
    aliases = {
        "object_type_name": "Пешеходная дорожка",
        "coating_type_name": coating,
        "parent_object_name": yard,
        "object_status_name": status,
        "source": "АСУ ОДС",
        "source_id": str(props.get("id")),
    }
    if area is not None:
        aliases["total_area"] = area
    return {**props, **aliases}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, help="каталог с GeoJSON по районам")
    parser.add_argument("--out", required=True, help="каталог слоя и точек")
    args = parser.parse_args()
    source = Path(args.source)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    layer_total = 0
    points = []
    for path in sorted(source.glob("*.geojson")):
        slug = path.stem
        data = json.loads(path.read_text(encoding="utf-8"))
        features = []
        for feature in data.get("features", []):
            props = feature.get("properties") or {}
            if not props.get("id"):
                continue
            props = layer_properties(props)
            features.append({"type": "Feature", "geometry": feature["geometry"], "properties": props})
            geom = shape(feature["geometry"])
            for lon, lat, ordinal, route in sample(geom, props):
                points.append({
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [lon, lat]},
                    "properties": {
                        "point_no": f"ПД-{props['id']}-{ordinal:02d}",
                        "path_id": props["id"],
                        "ogh_id": props.get("ogh_id"),
                        "ordinal": ordinal,
                        "district": props.get("district") or SLUGS.get(slug, ""),
                        "address": props.get("yard") or "",
                        "route_m": route,
                        "area": props.get("area"),
                        "coating": props.get("coating") or "",
                    },
                })
        layer_total += len(features)
        (out / f"{slug}.geojson").write_text(json.dumps(
            {"type": "FeatureCollection", "name": f"peshehodnye_dorozhki_{slug}", "features": features},
            ensure_ascii=False), encoding="utf-8")

    points.sort(key=lambda f: (f["properties"]["district"], str(f["properties"]["path_id"]), f["properties"]["ordinal"]))
    (out / "points.geojson").write_text(json.dumps(
        {"type": "FeatureCollection", "name": "peshehodnye_dorozhki_points", "features": points},
        ensure_ascii=False), encoding="utf-8")
    per_district = {}
    for point in points:
        district = point["properties"]["district"]
        per_district[district] = per_district.get(district, 0) + 1
    print(f"дорожек: {layer_total}, точек съёмки: {len(points)}")
    for name, count in sorted(per_district.items()):
        print(f"  {name}: {count}")


if __name__ == "__main__":
    main()
