"""Строит полный презентационный маршрут СММ по дорогам/проездам двора.

Для каждого эталонного двора из smm.geojson строится осевая линия
маршрута по периметру проездов (или по центральной оси двора) и
набор векторов выброса вдоль неё — как на презентационном скриншоте:
линия маршрута по дороге + короткие стрелки выброса.

Маршруты генерируются из контура двора (АСУ ОДС) геометрически:
  - периметр контура = внешний проезд;
  - внутрь от него, на фиксированный отступ, — осевая линия движения;
  - вдоль неё, с шагом ~18 м, — точки выброса с азимутом внутрь двора.

Результат пишется в work/smm_tracks/*.gpx (маршруты) и
work/smm_tracks/*.nozzle.json (замеры выброса) — их уже
подхватывает генератор оверлея (source=gpx/json).

Запуск: python work/build_smm_road_routes.py [--out-track-dir work/smm_tracks]
"""

import argparse
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT_TRACK_DIR = ROOT / "work" / "smm_tracks"
SRC = ROOT / "smm.geojson"


def polygon_ring(geometry):
    if geometry["type"] == "Polygon":
        return geometry["coordinates"][0]
    if geometry["type"] == "MultiPolygon":
        return geometry["coordinates"][0][0]
    raise SystemExit(f"Не полигон: {geometry['type']}")


def ring_centroid(ring):
    x = sum(p[0] for p in ring) / len(ring)
    y = sum(p[1] for p in ring) / len(ring)
    return [x, y]


def inset_ring(ring, centroid, distance_m):
    """Ужимает кольцо к центроиду на distance_m (для осевой линии проезда)."""
    out = []
    for p in ring:
        dx = p[0] - centroid[0]
        dy = p[1] - centroid[1]
        dist = math.hypot(dx, dy) or 1e-9
        scale = max(0.0, 1.0 - distance_m / (dist * 111320.0))
        out.append([centroid[0] + dx * scale, centroid[1] + dy * scale])
    return out


def decimate_ring(ring, max_points=220):
    step = max(1, len(ring) // max_points)
    return ring[::step]


def bearing_to_centroid(p, centroid):
    dx = centroid[0] - p[0]
    dy = centroid[1] - p[1]
    return (math.degrees(math.atan2(dx * math.cos(math.radians(p[1])), dy)) + 360.0) % 360.0


def build_route_for(yard):
    ring = polygon_ring(yard["geometry"])
    centroid = ring_centroid(ring)
    # Осевая линия: ужимаем внешний контур на ~4 м внутрь (ширина проезда),
    # оставляя линию по «дороге».
    axis = inset_ring(ring, centroid, 4.0)
    axis = decimate_ring(axis, 200)
    # Замыкаем кольцо явно.
    if axis[0] != axis[-1]:
        axis = axis + [axis[0]]

    # Векторы выброса: вдоль оси, но со смещением на ~1.5 м наружу
    # от линии (оператор едет по осевой, выбрасывает в сторону двора).
    nozzle = []
    step = max(1, len(axis) // 18)
    for i in range(0, len(axis) - 1, step):
        p = axis[i]
        b = bearing_to_centroid(p, centroid)
        nozzle.append([round(p[0], 6), round(p[1], 6), round(b, 1)])
    return axis, nozzle, centroid


def write_gpx(variant, axis):
    path = OUT_TRACK_DIR / f"{variant}.gpx"
    body = "".join(
        f'<trkpt lat="{p[1]:.6f}" lon="{p[0]:.6f}"/>' for p in axis
    )
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<gpx version="1.1" creator="karta-sao-smm" xmlns="http://www.topografix.com/GPX/1/1">\n'
        f'<trk><name>{variant}</name><trkseg>{body}</trkseg></trk>\n</gpx>\n',
        encoding="utf-8",
    )
    return path


def write_nozzle(variant, nozzle, source_note):
    path = OUT_TRACK_DIR / f"{variant}.nozzle.json"
    path.write_text(
        json.dumps(
            {"points": nozzle, "source_note": source_note},
            ensure_ascii=False, indent=1,
        ),
        encoding="utf-8",
    )
    return path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--src", default=str(SRC))
    parser.add_argument("--out-track-dir", default=str(OUT_TRACK_DIR))
    parser.add_argument("--overwrite", action="store_true", help="перезаписать существующие треки")
    args = parser.parse_args()

    src = Path(args.src)
    tracks = Path(args.out_track_dir)
    tracks.mkdir(parents=True, exist_ok=True)

    data = json.loads(src.read_text(encoding="utf-8"))
    for feature in data["features"]:
        variant = feature["id"].removeprefix("smm-")
        axis, nozzle, centroid = build_route_for(feature)
        gpx = write_gpx(variant, axis)
        note = "Презентационный маршрут по проезду, из контура АСУ ОДС (осевая линия)."
        njson = write_nozzle(variant, nozzle, note)
        print(f"{variant}: ось {len(axis)} тчк, выброс {len(nozzle)} тчк -> {gpx.name}, {njson.name}")


if __name__ == "__main__":
    main()