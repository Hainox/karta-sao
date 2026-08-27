"""Собирает корневой smm_routes.geojson — слой быстрых переходов СММ.

Для каждого эталонного двора (dt1..dt5) из корневого smm.geojson создаются:
  - variant_outline  — контур двора (зона приближения по кнопке в панели);
  - route_direction  — направление движения по маршруту;
  - nozzle_direction — направление выброса снега.

Источники направлений, в порядке приоритета:
  1. Реальные GPS-треки из work/smm_tracks/ (если есть):
       dt1.gpx ... dt5.gpx          — трек движения машины: из него строится
                                      геометрия LineString (фактический маршрут)
                                      и вычисляется азимут по сегментам;
       dt1.nozzle.json ... — замеры направлений выброса: точки с азимутами
                                      ({"points": [[lng, lat, bearing], ...]}
                                      или FeatureCollection с bearing).
  2. Иначе — схематичный якорь на контуре из smm.geojson (прежнее поведение):
     азимут и семантика берутся из утверждённых схем smm/dt*.svg и паспортных
     описаний (work/smm-karta-sao). Для вариантов, где направление выброса
     не утверждено (ДТ-4, ДТ-5), bearing = null.

Форматы треков подробно описаны в work/smm_tracks/README.md. Треки
необязательны: если каталог пуст или файлов нет, оверлей полностью
совпадает со схематичным режимом.

Запуск:
    python work/build_smm_routes_overlay.py
    python work/build_smm_routes_overlay.py --tracks-dir work/smm_tracks --out smm_routes.geojson
"""

import argparse
import json
import math
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "smm.geojson"
OUT = ROOT / "smm_routes.geojson"
TRACKS_DIR = ROOT / "work" / "smm_tracks"

# Семантика схем: сторона входа маршрута, направление хода, азимут выброса.
# route_side — сторона bbox, с которой маршрут входит в двор (w/e/s/n);
# inset — доля размера, на которую якорь отступает внутрь двора.
VARIANTS = {
    "dt1": {  # «Каре»: кольцевой обход, выброс влево внутрь двора (азимут 90° влево -> север)
        "route_side": "s", "route_inset": 0.06, "route_bearing": 90,
        "nozzle_mode": "center", "nozzle_bearing": 0,
        "nozzle_note": "азимут 90° влево (внутрь двора), дефлектор 40° навесной, R = 5,0 м",
    },
    "dt2": {  # «Линейный»: движение вдоль фасада (на восток), выброс вправо на газон (юг)
        "route_side": "s", "route_inset": 0.10, "route_bearing": 90,
        "nozzle_mode": "center_south", "nozzle_bearing": 180,
        "nozzle_note": "азимут 90° вправо на газон, дефлектор 20° настильный, R = 5,0–7,0 м",
    },
    "dt3": {  # «Гребёнка»: проход между домами, выброс строго вперёд по ходу
        "route_side": "w", "route_inset": 0.06, "route_bearing": 90,
        "nozzle_mode": "east", "nozzle_bearing": 90,
        "nozzle_note": "азимут 0° строго вперёд по ходу, дефлектор 20° настильный, R = 7,0 м",
    },
    "dt4": {  # «Два корпуса»: челночные проходы в межкорпусном проезде (первый проход — на восток)
        "route_side": "w", "route_inset": 0.06, "route_bearing": 90,
        "nozzle_mode": None, "nozzle_bearing": None,
        "nozzle_note": "определяется после натурного осмотра",
    },
    "dt5": {  # «Полукольцо»: дуговой проход по внутреннему проезду (верхняя дуга — на восток), по часовой
        "route_side": "n", "route_inset": 0.06, "route_bearing": 90,
        "nozzle_mode": None, "nozzle_bearing": None,
        "nozzle_note": "определяется после натурного осмотра",
    },
}

VECTOR_STATUS = "Схематично; привязано к контуру АСУ ОДС, уточняется после натурного осмотра"

ROUTE_LINE_CAP = 300
NOZZLE_TRACK_CAP = 200


def bbox(geometry):
    rings = []
    if geometry["type"] == "Polygon":
        rings = geometry["coordinates"]
    elif geometry["type"] == "MultiPolygon":
        rings = [ring for poly in geometry["coordinates"] for ring in poly]
    pts = [pt for ring in rings for pt in ring]
    xs = [pt[0] for pt in pts]
    ys = [pt[1] for pt in pts]
    return min(xs), min(ys), max(xs), max(ys)


def side_anchor(bbox_, side, inset):
    minx, miny, maxx, maxy = bbox_
    cx = (minx + maxx) / 2
    cy = (miny + maxy) / 2
    w = maxx - minx
    h = maxy - miny
    if side == "s":
        return [cx, miny + h * inset]
    if side == "n":
        return [cx, maxy - h * inset]
    if side == "w":
        return [minx + w * inset, cy]
    if side == "e":
        return [maxx - w * inset, cy]
    return [cx, cy]


def nozzle_anchor(bbox_, mode):
    minx, miny, maxx, maxy = bbox_
    cx = (minx + maxx) / 2
    cy = (miny + maxy) / 2
    h = maxy - miny
    w = maxx - minx
    if mode == "center":
        return [cx, cy]
    if mode == "center_south":
        return [cx, cy + h * 0.08]
    if mode == "east":
        return [cx + w * 0.15, cy]
    return [cx, cy]


def decimate(points, cap):
    """Прореживает трек до cap точек, сохраняя первую и последнюю."""
    if len(points) <= cap:
        return list(points)
    step = len(points) / cap
    out = [points[int(i * step)] for i in range(cap)]
    if out[-1] != points[-1]:
        out.append(points[-1])
    return out


def segment_bearing(p1, p2):
    """Азимут (0° = север, по часовой) сегмента [p1, p2] в WGS84."""
    lng1, lat1 = p1
    lng2, lat2 = p2
    if lng1 == lng2 and lat1 == lat2:
        return None
    mid_lat = math.radians((lat1 + lat2) / 2)
    dx = math.radians(lng2 - lng1) * math.cos(mid_lat)
    dy = math.radians(lat2 - lat1)
    return (math.degrees(math.atan2(dx, dy)) + 360.0) % 360.0


def circular_mean(degrees):
    xs = sum(math.cos(math.radians(d)) for d in degrees)
    ys = sum(math.sin(math.radians(d)) for d in degrees)
    if xs == 0 and ys == 0:
        return 0.0
    return (math.degrees(math.atan2(ys, xs)) + 360.0) % 360.0


def load_gpx_track(path):
    """Читает GPX 1.1: все точки <trkpt> из всех trkseg как [lng, lat]."""
    root = ET.parse(path).getroot()
    points = []
    for trkpt in root.iter():
        if trkpt.tag.rsplit("}", 1)[-1] != "trkpt":
            continue
        lat = float(trkpt.attrib.get("lat"))
        lon = float(trkpt.attrib.get("lon"))
        points.append([lon, lat])
    return points


def load_nozzle_points(path):
    """Читает замеры выброса: list of (lng, lat, bearing).

    Формат 1: {"points": [[lng, lat, bearing], ...]}
    Формат 2: FeatureCollection из Point-фич со свойством bearing.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    points = []
    if isinstance(data, dict) and "points" in data:
        for row in data["points"]:
            if isinstance(row, dict):
                points.append((float(row.get("lng")), float(row.get("lat")),
                               float(row.get("bearing", row.get("azimuth", 0)))))
            else:
                bearing = float(row[2]) if len(row) > 2 else 0.0
                points.append((float(row[0]), float(row[1]), bearing))
    elif isinstance(data, dict) and data.get("type") == "FeatureCollection":
        for feature in data.get("features", []):
            geom = feature.get("geometry") or {}
            coords = geom.get("coordinates")
            if geom.get("type") != "Point" or not coords:
                continue
            props = feature.get("properties") or {}
            points.append((float(coords[0]), float(coords[1]),
                           float(props.get("bearing", props.get("azimuth", 0)))))
    return points


def build(src_path, out_path, tracks_dir):
    source = json.loads(src_path.read_text(encoding="utf-8"))
    by_id = {feature["id"]: feature for feature in source["features"]}

    tracks_dir = Path(tracks_dir)
    track_usage = {}
    features = []

    for variant_id, cfg in VARIANTS.items():
        yard = by_id.get(f"smm-{variant_id}")
        if yard is None:
            raise SystemExit(f"В {src_path} нет объекта smm-{variant_id}")
        props = dict(yard["properties"])
        geometry = yard["geometry"]
        box = bbox(geometry)
        code = props.get("code") or f"ДТ-{variant_id[-1]}"

        outline = {
            "type": "Feature",
            "id": f"smm-variant-{variant_id}",
            "properties": {
                "variant_id": variant_id,
                "feature_kind": "variant_outline",
                "code": code,
                "name": props.get("name", ""),
                "district": props.get("district", ""),
                "section": props.get("section", ""),
                "address": props.get("address", ""),
                "detail": props.get("detail", ""),
                "scheme": props.get("scheme", ""),
                "storage": props.get("storage", ""),
                "passes": props.get("passes", ""),
                "status": props.get("status", ""),
                "source_yard_id": props.get("source_yard_id", props.get("asu_ods_object_id", "")),
            },
            "geometry": geometry,
        }
        features.append(outline)

        route_file = tracks_dir / f"{variant_id}.gpx"
        nozzle_file = tracks_dir / f"{variant_id}.nozzle.json"
        usage = {"route": "schematic", "nozzle": "schematic"}
        route_points = load_gpx_track(route_file) if route_file.exists() else []

        if len(route_points) >= 2:
            usage["route"] = "gpx"
            bearings = [b for b in (segment_bearing(a, b) for a, b in zip(route_points, route_points[1:])) if b is not None]
            line = decimate(route_points, ROUTE_LINE_CAP)
            features.append({
                "type": "Feature",
                "id": f"smm-route-{variant_id}",
                "properties": {
                    "variant_id": variant_id,
                    "feature_kind": "route_direction",
                    "bearing": round(circular_mean(bearings) if bearings else float("nan"), 1),
                    "source": "gpx",
                    "track_file": route_file.name,
                    "track_points": len(route_points),
                    "name": f"{code}: направление движения по маршруту",
                    "status": f"GPS-трек ({len(route_points)} точек): фактический маршрут",
                },
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[round(pt[0], 6), round(pt[1], 6)] for pt in line],
                },
            })
        else:
            features.append({
                "type": "Feature",
                "id": f"smm-route-{variant_id}",
                "properties": {
                    "variant_id": variant_id,
                    "feature_kind": "route_direction",
                    "bearing": cfg["route_bearing"],
                    "name": f"{code}: направление движения по маршруту",
                    "status": VECTOR_STATUS,
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(v, 6) for v in side_anchor(box, cfg["route_side"], cfg["route_inset"])],
                },
            })

        nozzle_points = load_nozzle_points(nozzle_file) if nozzle_file.exists() else []

        if nozzle_points:
            usage["nozzle"] = "json"
            bearings = [pt[2] for pt in nozzle_points]
            track = decimate(nozzle_points, NOZZLE_TRACK_CAP)
            first = nozzle_points[0]
            features.append({
                "type": "Feature",
                "id": f"smm-nozzle-{variant_id}",
                "properties": {
                    "variant_id": variant_id,
                    "feature_kind": "nozzle_direction",
                    "bearing": round(circular_mean(bearings), 1),
                    "source": "json",
                    "track_file": nozzle_file.name,
                    "nozzle_track": [[round(p[0], 6), round(p[1], 6), round(p[2], 1)] for p in track],
                    "name": f"{code}: направление выброса снега",
                    "note": cfg["nozzle_note"],
                    "status": f"Замер направлений выброса: {len(nozzle_points)} точек",
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(first[0], 6), round(first[1], 6)],
                },
            })
        else:
            anchor = (nozzle_anchor(box, cfg["nozzle_mode"])
                      if cfg["nozzle_mode"]
                      else [round((box[0] + box[2]) / 2, 6), round((box[1] + box[3]) / 2, 6)])
            features.append({
                "type": "Feature",
                "id": f"smm-nozzle-{variant_id}",
                "properties": {
                    "variant_id": variant_id,
                    "feature_kind": "nozzle_direction",
                    "bearing": cfg["nozzle_bearing"],
                    "name": f"{code}: направление выброса снега",
                    "note": cfg["nozzle_note"],
                    "status": VECTOR_STATUS if cfg["nozzle_bearing"] is not None
                    else "не утверждено; определяется после натурного осмотра",
                },
                "geometry": {
                    "type": "Point",
                    "coordinates": [round(v, 6) for v in anchor],
                },
            })

        track_usage[variant_id] = usage

    data = {
        "type": "FeatureCollection",
        "name": "smm_routes",
        "metadata": {
            "title": "Маршруты СММ — быстрые переходы и направления",
            "description": "Слой-оверлей к слою «Маршруты СММ» общей карты: кнопки быстрого приближения к пяти эталонным дворам и векторы направления движения и выброса снега.",
            "source": "Контуры: АСУ ОДС (smm.geojson). Направления: реальные GPS-треки work/smm_tracks/ при наличии, иначе схемы smm/dt*.svg и паспортные описания из work/smm-karta-sao.",
            "bearing_convention": "Азимут, градусов: 0 = север, по часовой стрелке. bearing = null — направление не утверждено.",
            "track_note": "route_direction с source=gpx — фактический маршрут (LineString); nozzle_direction с source=json — замеры азимутов выброса (nozzle_track). Без треков оверлей остаётся схематичным.",
            "track_usage": track_usage,
            "generated_at": "2026-08-27",
            "feature_count": len(features),
        },
        "features": features,
    }
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Записано {len(features)} объектов: {out_path}")
    print("Источники:", json.dumps(track_usage, ensure_ascii=False))


def main(argv=None):
    parser = argparse.ArgumentParser(description="Сборка smm_routes.geojson")
    parser.add_argument("--src", default=str(SRC), help="исходный smm.geojson")
    parser.add_argument("--out", default=str(OUT), help="куда записать результат")
    parser.add_argument("--tracks-dir", default=str(TRACKS_DIR), help="каталог GPS-треков (необязательно)")
    args = parser.parse_args(argv)
    build(Path(args.src), Path(args.out), args.tracks_dir)


if __name__ == "__main__":
    main()