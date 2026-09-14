"""Собирает корневой smm_routes.geojson — слой быстрых переходов СММ.

Для каждого эталонного двора (dt1..dt5) из корневого smm.geojson создаются:
  - variant_outline  — контур двора (зона приближения по кнопке в панели);
  - route_direction  — направление движения по маршруту;
  - nozzle_direction — направление выброса снега.

Источники направлений:
  - Файлы dt1.gpx ... dt5.gpx хранят линии движения в GPX. GPX — только формат:
    фактическим GPS-треком линия считается при явной маркировке
    route_source_kind=gps/gnss (либо source_kind для старых файлов). Проектные линии маркируются как
    inner_yard_reference, reference_scheme или yard_route.
  - Файлы dt1.nozzle.json ... хранят точки с азимутами. Полевыми замерами они
    считаются только при явной маркировке nozzle_source_kind=measurement
    (либо source_kind для старых файлов).
  - Если GPX отсутствует — используется схематичный якорь на контуре smm.geojson:
    азимут и семантика берутся из схем smm/dt*.svg и паспортных
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


def route_direction_summary(bearings, multidirectional_threshold=0.8):
    """Return one bearing only when segment headings share a clear direction."""
    if not bearings:
        return None, "unknown"

    xs = sum(math.cos(math.radians(value)) for value in bearings)
    ys = sum(math.sin(math.radians(value)) for value in bearings)
    concentration = math.hypot(xs, ys) / len(bearings)
    if concentration < multidirectional_threshold:
        return None, "multidirectional"
    return round(circular_mean(bearings), 1), "single_direction"


def load_gpx_segments(path):
    """Read GPX 1.1 while retaining each <trkseg> as a separate line."""
    root = ET.parse(path).getroot()
    segments = []
    for segment in root.iter():
        if segment.tag.rsplit("}", 1)[-1] != "trkseg":
            continue
        points = []
        for trkpt in segment:
            if trkpt.tag.rsplit("}", 1)[-1] != "trkpt":
                continue
            lat = float(trkpt.attrib.get("lat"))
            lon = float(trkpt.attrib.get("lon"))
            points.append([lon, lat])
        if points:
            segments.append(points)
    return segments


def provenance_origin(metadata, dimension):
    """Read semantic provenance; a GPX or JSON file alone is not evidence."""
    metadata = metadata if isinstance(metadata, dict) else {}
    specific_key = f"{dimension}_source_kind"
    source_kind = metadata.get(specific_key, metadata.get("source_kind"))
    aliases = {
        "reference_scheme": "reference_scheme",
        "inner_yard_reference": "inner_yard_reference",
        "gps": "gps",
        "gnss": "gps",
        "yard_route": "yard_route",
        "project_route": "yard_route",
        "measurement": "measurement",
        "measured": "measurement",
    }
    if source_kind in aliases:
        origin = aliases[source_kind]
        if dimension == "route" and origin == "measurement":
            return "unverified"
        return origin

    note = str(metadata.get("source_note", "")).strip().lower()
    if note.startswith("презентационный") or note.startswith("маршрут внутри двора"):
        return "yard_route"
    if note.startswith("проектная схема"):
        return "reference_scheme"
    return "unverified"


def source_label(origin, file_format):
    if origin in {"inner_yard_reference", "reference_scheme"}:
        return "reference_scheme"
    if origin == "yard_route":
        return "yard_route"
    if origin == "measurement":
        return "measurement"
    if origin == "gps":
        return file_format
    return "unverified"


def load_nozzle_points(path):
    """Читает замеры выброса: list of (lng, lat, bearing).

    Формат 1: {"points": [[lng, lat, bearing], ...]}
    Формат 2: FeatureCollection из Point-фич со свойством bearing.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    points = []
    if isinstance(data, dict) and "points" in data:
        for row in data["points"]:
            try:
                if isinstance(row, dict):
                    points.append((float(row["lng"]), float(row["lat"]),
                                   float(row.get("bearing", row.get("azimuth", 0)))))
                elif isinstance(row, (list, tuple)) and len(row) >= 3:
                    points.append((float(row[0]), float(row[1]), float(row[2])))
            except (KeyError, TypeError, ValueError):
                continue
    elif isinstance(data, dict) and data.get("type") == "FeatureCollection":
        for feature in data.get("features", []):
            try:
                geom = feature.get("geometry") or {}
                coords = geom.get("coordinates")
                if geom.get("type") != "Point" or not isinstance(coords, (list, tuple)) or len(coords) < 2:
                    continue
                props = feature.get("properties") or {}
                points.append((float(coords[0]), float(coords[1]),
                               float(props.get("bearing", props.get("azimuth", 0)))))
            except (AttributeError, KeyError, TypeError, ValueError):
                continue
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
        route_segments = load_gpx_segments(route_file) if route_file.exists() else []
        route_segments = [segment for segment in route_segments if len(segment) >= 2]
        source_note = ""
        nozzle_metadata = {}
        if nozzle_file.exists():
            try:
                nozzle_meta = json.loads(nozzle_file.read_text(encoding="utf-8"))
                if isinstance(nozzle_meta, dict):
                    nozzle_metadata = nozzle_meta
                    source_note = str(nozzle_meta.get("source_note", ""))
            except (OSError, json.JSONDecodeError):
                nozzle_metadata = {}

        route_origin = provenance_origin(nozzle_metadata, "route")
        nozzle_origin = provenance_origin(nozzle_metadata, "nozzle")

        if route_segments:
            usage["route"] = "gpx"
            route_points = [point for segment in route_segments for point in segment]
            bearings = [
                bearing
                for segment in route_segments
                for bearing in (segment_bearing(a, b) for a, b in zip(segment, segment[1:]))
                if bearing is not None
            ]
            route_bearing, movement_mode = route_direction_summary(bearings)
            direction_note = (
                "; маршрут многовекторный, единый азимут не применяется"
                if movement_mode == "multidirectional" else ""
            )
            if route_origin == "inner_yard_reference":
                route_status = f"Внутридворовая проектная линия по приложенной схеме ({len(route_points)} точек): требует полевой сверки{direction_note}"
            elif route_origin == "reference_scheme":
                route_status = f"Проектная линия по приложенной схеме ({len(route_points)} точек): требует полевой сверки{direction_note}"
            elif route_origin == "yard_route":
                route_status = f"Проектный маршрут внутри двора ({len(route_points)} точек): требует полевой сверки{direction_note}"
            elif route_origin == "gps":
                route_status = f"GPS-трек ({len(route_points)} точек): фактический маршрут{direction_note}"
            else:
                route_status = f"Линия GPX ({len(route_points)} точек): источник не указан, требуется проверка{direction_note}"

            for segment_index, segment in enumerate(route_segments, start=1):
                line = decimate(segment, ROUTE_LINE_CAP)
                suffix = f"-segment-{segment_index}" if len(route_segments) > 1 else ""
                features.append({
                    "type": "Feature",
                    "id": f"smm-route-{variant_id}{suffix}",
                    "properties": {
                        "variant_id": variant_id,
                        "feature_kind": "route_direction",
                        "arrow_type": "movement",
                        "bearing": route_bearing,
                        "movement_mode": movement_mode,
                        "source": source_label(route_origin, "gpx"),
                        "route_origin": route_origin,
                        "source_note": source_note,
                        "track_file": route_file.name,
                        "track_points": len(route_points),
                        "track_segments": len(route_segments),
                        "track_segment": segment_index,
                        "name": f"{code}: направление движения по маршруту",
                        "status": route_status,
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
                    "arrow_type": "movement",
                    "bearing": cfg["route_bearing"],
                    "movement_mode": "single_direction" if cfg["route_bearing"] is not None else "unknown",
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
            if nozzle_origin == "inner_yard_reference":
                nozzle_status = f"Направления сопла по внутридворовой схеме ({len(nozzle_points)} точек): требуют полевой сверки"
            elif nozzle_origin == "reference_scheme":
                nozzle_status = f"Направления сопла по приложенной схеме ({len(nozzle_points)} точек): требуют полевой сверки"
            elif nozzle_origin == "yard_route":
                nozzle_status = f"Проектные направления выброса по схеме ({len(nozzle_points)} точек): требуют полевой сверки"
            elif nozzle_origin == "measurement":
                nozzle_status = f"Замер направлений выброса: {len(nozzle_points)} точек"
            elif nozzle_origin == "gps":
                nozzle_status = f"Направления сопла по данным GNSS ({len(nozzle_points)} точек)"
            else:
                nozzle_status = f"Направления выброса из JSON ({len(nozzle_points)} точек): источник не указан, требуется проверка"
            features.append({
                "type": "Feature",
                "id": f"smm-nozzle-{variant_id}",
                "properties": {
                    "variant_id": variant_id,
                    "feature_kind": "nozzle_direction",
                    "arrow_type": "nozzle",
                    "bearing": round(circular_mean(bearings), 1),
                    "source": source_label(nozzle_origin, "json"),
                    "route_origin": route_origin,
                    "nozzle_origin": nozzle_origin,
                    "source_note": source_note,
                    "track_file": nozzle_file.name,
                    "nozzle_track": [[round(p[0], 6), round(p[1], 6), round(p[2], 1)] for p in track],
                    "name": f"{code}: направление выброса снега",
                    "note": cfg["nozzle_note"],
                    "status": nozzle_status,
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
                    "arrow_type": "nozzle",
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
            "source": "Контуры: источник указан отдельно для каждого двора в smm.geojson. Источник маршрута и направлений сопла определяется метаданными; GPX/JSON — только формат файла, не подтверждение полевого замера.",
        "bearing_convention": "Азимут, градусов: 0 = север, по часовой стрелке. bearing = null вместе с movement_mode=multidirectional — единый азимут не применяется; в остальных случаях null означает, что направление не подтверждено.",
            "track_note": "route_origin=gps устанавливается только при явном source_kind=gps/gnss; route_origin=inner_yard_reference/reference_scheme/yard_route обозначает проектную линию и требует полевой сверки; unverified — источник не указан. nozzle_origin=measurement устанавливается только при явной маркировке замера. movement_mode=multidirectional означает, что единого азимута маршрута нет; направление движения читается по линиям и стрелкам схемы.",
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
