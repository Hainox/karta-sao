"""Рабочий скрипт: достаёт геометрию проездов (дорог) из OpenStreetMap
по адресам эталонных дворов СММ, чтобы строить полные презентационные
маршруты именно по дорогам (не по дворам).

Использует OSM Overpass API (GET, без ключа). Результат пишется как
smm/road_geometry.json (полилинии проездов в WGS84) и используется
скриптом маршрутизации work/build_smm_road_routes.py.

Запуск:  python work/fetch_osm_roads.py [--once]
"""

import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "smm" / "road_geometry.json"

# Для каждого двора — КЛЮЧЕВОЙ адрес (точка улицы/проезда), вокруг которого
# ищем дороги. Радиус поиска — 400 м, чтобы захватить весь комплекс дворов.
YARDS = {
    "dt1": {"addr": "ул. Новопесчаная, 21", "radius": 400},
    "dt2": {"addr": "ул. Дубнинская, 30", "radius": 400},
    "dt3": {"addr": "Бескудниковский бульвар, 20", "radius": 400},
    "dt4": {"addr": "1-й Амбулаторный проезд, 5", "radius": 400},
    "dt5": {"addr": "Старопетровский проезд, 10", "radius": 400},
}

OVERPASS = "https://overpass-api.de/api/interpreter"
# Highway-теги, которые считаем «дорогами/проездами» для маршрута СММ.
ROAD_HIGHWAYS = {
    "service", "residential", "unclassified", "living_street", "service:yard",
    "pedestrian", "footway", "path", "track",
}
# Прочие highway (primary, motorway и т.п.) исключаем намеренно.


def geocode(addr):
    """Номинатим-геокодинг (бесплатный, без ключа). Возвращает [lon, lat]."""
    url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(
        {"q": addr + ", Москва", "format": "json", "limit": 1}
    )
    req = urllib.request.Request(url, headers={"User-Agent": "karta-sao-smm/1.0"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        rows = json.loads(resp.read().decode("utf-8"))
    if not rows:
        raise SystemExit(f"Не найден адрес: {addr}")
    return [float(rows[0]["lon"]), float(rows[0]["lat"])]


def fetch_roads_around(lon, lat, radius):
    """Overpass: все дороги ROAD_HIGHWAYS в радиусе radius метров вокруг точки."""
    query = f"""
    [out:json][timeout:40];
    (
      way(around:{radius},{lat},{lon})["highway"];
    );
    out geom;
    """
    data = urllib.parse.urlencode({"data": query}).encode("utf-8")
    req = urllib.request.Request(OVERPASS, data=data, headers={"User-Agent": "karta-sao-smm/1.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    return payload.get("elements", [])


def main():
    result = {}
    for key, cfg in YARDS.items():
        lon, lat = geocode(cfg["addr"])
        time.sleep(1.2)  # вежливость к Nominatim
        ways = fetch_roads_around(lon, lat, cfg["radius"])
        lines = []
        for way in ways:
            geom = way.get("geometry")
            if not geom or len(geom) < 2:
                continue
            coords = [[float(p["lon"]), float(p["lat"])] for p in geom]
            lines.append({
                "osm_id": way.get("id"),
                "highway": way.get("tags", {}).get("highway", ""),
                "name": way.get("tags", {}).get("name", ""),
                "coords": coords,
            })
        result[key] = {
            "anchor": [lon, lat],
            "radius": cfg["radius"],
            "roads": lines,
        }
        print(f"{key}: {len(lines)} дорог, anchor={lon:.5f},{lat:.5f}")
        time.sleep(2)  # вежливость к Overpass

    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Сохранено: {OUT}")


if __name__ == "__main__":
    main()