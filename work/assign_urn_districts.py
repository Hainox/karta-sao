"""Проставляет район урнам, у которых в выгрузке МАФ района нет, и пересобирает KML.

В снимке `urns_sao_active_snapshot.geojson` 4 482 урны пришли с районом
«без_района», ещё 15 — сразу с двумя районами через «;». Почти все они стоят
внутри границ районов САО, поэтому район берётся по `districts.geojson`
(точка внутри границы) и помечается `district_source: "boundary"`, чтобы было
видно, что это не значение из источника. Участок не трогается: урна вне двора
остаётся «Без участка». Урна вне всех границ получает пустой район
(«Без района» на карте).

KML собирается из GeoJSON заново: папка на район, в подписи папки — число урн
в ней. Повторный запуск ничего не меняет.

    python work/assign_urn_districts.py
"""
import json
from html import escape
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
URNS = ROOT / "urns_sao_active_snapshot.geojson"
KML = ROOT / "urns_sao_active_snapshot.kml"
DISTRICTS = ROOT / "districts.geojson"
NO_DISTRICT = "Без района"


def assign_districts(urns, districts):
    names = [f["properties"]["district"] for f in districts["features"]]
    polygons = [shape(f["geometry"]) for f in districts["features"]]
    tree = STRtree(polygons)
    known = set(names)
    changed = 0
    for feature in urns["features"]:
        properties = feature["properties"]
        if properties["district"] in known or properties["district"] == "":
            continue
        point = Point(feature["geometry"]["coordinates"])
        hits = sorted(names[i] for i in tree.query(point) if polygons[i].covers(point))
        properties["district"] = hits[0] if hits else ""
        if hits:
            properties["district_source"] = "boundary"
        changed += 1
    return changed


def placemark(feature):
    p = feature["properties"]
    lon, lat = feature["geometry"]["coordinates"]
    description = "\n".join((
        f"Тип: {p['type']}",
        f"Двор: {p['yard']}",
        f"Район: {p['district'] or NO_DISTRICT}",
        f"Материал: {p['material']}",
        f"ID: {feature['id']}",
        f"Статус: {p['status']}",
    ))
    return (f"<Placemark><name>{escape(p['name'], quote=False)}</name>"
            f"<description>{escape(description, quote=False)}</description>"
            f"<Point><coordinates>{lon},{lat},0</coordinates></Point></Placemark>")


def build_kml(urns):
    groups = {}
    for feature in urns["features"]:
        groups.setdefault(feature["properties"]["district"] or NO_DISTRICT, []).append(feature)
    order = sorted((name for name in groups if name != NO_DISTRICT), key=str.lower)
    if NO_DISTRICT in groups:
        order.append(NO_DISTRICT)
    parts = ["<?xml version='1.0' encoding='utf-8'?>",
             '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>',
             "<name>МАФ САО (WGS84)</name>"]
    for name in order:
        parts.append(f"<Folder><name>{escape(name, quote=False)} ({len(groups[name])})</name>")
        parts.extend(placemark(feature) for feature in groups[name])
        parts.append("</Folder>")
    parts.append("</Document></kml>")
    return "\n".join(parts)


def main():
    urns = json.loads(URNS.read_text(encoding="utf-8"))
    districts = json.loads(DISTRICTS.read_text(encoding="utf-8"))
    changed = assign_districts(urns, districts)
    URNS.write_text(json.dumps(urns, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    KML.write_text(build_kml(urns), encoding="utf-8")
    by_boundary = sum(1 for f in urns["features"] if f["properties"].get("district_source") == "boundary")
    outside = sum(1 for f in urns["features"] if not f["properties"]["district"])
    print(f"Изменено урн: {changed}; район по границе всего: {by_boundary}; вне районов: {outside}")


if __name__ == "__main__":
    main()
