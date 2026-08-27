"""Собирает корневой smm_routes.geojson — слой быстрых переходов СММ.

Для каждого эталонного двора (dt1..dt5) из корневого smm.geojson создаются:
  - variant_outline  — контур двора (зона приближения по кнопке в панели);
  - route_direction  — вектор направления движения по маршруту (bearing);
  - nozzle_direction — вектор направления выброса снега (bearing или null,
    если направление ещё не утверждено и определяется после натурного осмотра).

Направления берутся из утверждённых схем smm/dt*.svg и паспортных описаний
(work/smm-karta-sao): углы азимутальные, 0° = север, по часовой стрелке.
Якоря векторов — схематические точки на реальных контурах АСУ ОДС (по bbox),
поэтому маркеры привязаны к двору, а не к миру. Точные GPS-треки маршрутов
появятся после натурных замеров; статус каждого вектора это фиксирует.

Запуск: python work/build_smm_routes_overlay.py
Выход:  smm_routes.geojson (корень репозитория, рядом с smm.geojson).
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "smm.geojson"
OUT = ROOT / "smm_routes.geojson"

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


def main():
    source = json.loads(SRC.read_text(encoding="utf-8"))
    by_id = {feature["id"]: feature for feature in source["features"]}

    features = []
    for variant_id, cfg in VARIANTS.items():
        yard = by_id.get(f"smm-{variant_id}")
        if yard is None:
            raise SystemExit(f"В {SRC} нет объекта smm-{variant_id}")
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

        route = {
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
                "coordinates": side_anchor(box, cfg["route_side"], cfg["route_inset"]),
            },
        }

        nozzle = {
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
                "coordinates": nozzle_anchor(box, cfg["nozzle_mode"]) if cfg["nozzle_mode"] else [round((box[0] + box[2]) / 2, 6), round((box[1] + box[3]) / 2, 6)],
            },
        }

        features.extend([outline, route, nozzle])

    for feature in features:
        if feature["geometry"]["type"] == "Point":
            feature["geometry"]["coordinates"] = [round(v, 6) for v in feature["geometry"]["coordinates"]]

    data = {
        "type": "FeatureCollection",
        "name": "smm_routes",
        "metadata": {
            "title": "Маршруты СММ — быстрые переходы и направления",
            "description": "Слой-оверлей к слою «Маршруты СММ» общей карты: кнопки быстрого приближения к пяти эталонным дворам и векторы направления движения и выброса снега.",
            "source": "Контуры: АСУ ОДС (smm.geojson). Направления: схемы smm/dt*.svg и паспортные описания из work/smm-karta-sao.",
            "bearing_convention": "Азимут, градусов: 0 = север, по часовой стрелке. bearing = null — направление не утверждено.",
            "note": "Векторы схематичны и привязаны к контуру двора; точные GPS-треки и азимуты выброса утверждаются после натурного осмотра.",
            "generated_at": "2026-08-27",
            "feature_count": len(features),
        },
        "features": features,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Записано {len(features)} объектов: {OUT}")


if __name__ == "__main__":
    main()