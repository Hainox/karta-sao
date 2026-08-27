"""Загружает геометрию дорог OSM вокруг пяти эталонных дворов СММ.

Использует официальный API OpenStreetMap (/api/0.6/map?bbox=...),
который отвечает XML. ВАЖНО: порядок bbox — minlon,minlat,maxlon,maxlat
(долгота, широта!), иначе API вернёт пустой ответ.

Результат: smm/road_geometry.json — словарь по вариантам:
  { "dt1": { "anchor": [lon,lat], "radius_deg": 0.003,
             "roads": [ {"osm_id", "highway", "name", "service", "coords": [[lon,lat],...]}, ... ] } }

Запуск: python work/fetch_osm_roads.py
"""

import json
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "smm" / "road_geometry.json"

YARDS = {
    "dt1": {"lon": 37.51246, "lat": 55.79437},
    "dt2": {"lon": 37.56073, "lat": 55.87733},
    "dt3": {"lon": 37.55963, "lat": 55.86630},
    "dt4": {"lon": 37.53549, "lat": 55.81092},
    "dt5": {"lon": 37.50871, "lat": 55.82296},
}
RADIUS_DEG = 0.003  # ~330 м

# Дороги, по которым СММ может двигаться во дворе (внутридворовые проезды,
# жилые улицы, тротуары). Магистрали исключаем.
ALLOWED_HIGHWAYS = {
    "service", "residential", "unclassified", "living_street", "pedestrian",
    "footway", "path", "track", "service:yard",
}


def fetch_map(lon, lat, radius=RADIUS_DEG):
    minlon = lon - radius
    minlat = lat - radius
    maxlon = lon + radius
    maxlat = lat + radius
    url = f"https://api.openstreetmap.org/api/0.6/map?bbox={minlon},{minlat},{maxlon},{maxlat}"
    req = urllib.request.Request(url, headers={"User-Agent": "karta-sao-smm/1.0"})
    with urllib.request.urlopen(req, timeout=180) as resp:
        return ET.fromstring(resp.read().decode("utf-8"))


def parse_root(root):
    nodes = {}
    for el in root:
        if el.tag == "node":
            nodes[el.get("id")] = (float(el.get("lon")), float(el.get("lat")))
    ways = []
    for el in root:
        if el.tag != "way":
            continue
        tags = {t.get("k"): t.get("v") for t in el if t.tag == "tag"}
        coords = []
        ok = True
        for nd in el:
            if nd.tag != "nd":
                continue
            ref = nd.get("ref")
            if ref not in nodes:
                ok = False
                break
            coords.append([nodes[ref][0], nodes[ref][1]])
        if ok and len(coords) >= 2:
            ways.append({"osm_id": el.get("id"), "tags": tags, "coords": coords})
    return ways


def main():
    result = {}
    for key, cfg in YARDS.items():
        root = fetch_map(cfg["lon"], cfg["lat"])
        ways = parse_root(root)
        roads = []
        for way in ways:
            highway = way["tags"].get("highway", "")
            if highway not in ALLOWED_HIGHWAYS:
                continue
            roads.append({
                "osm_id": way["osm_id"],
                "highway": highway,
                "name": way["tags"].get("name", ""),
                "service": way["tags"].get("service", ""),
                "coords": way["coords"],
            })
        result[key] = {
            "anchor": [cfg["lon"], cfg["lat"]],
            "radius_deg": RADIUS_DEG,
            "roads": roads,
        }
        print(f"{key}: {len(roads)} дорог", flush=True)
        time.sleep(1.2)

    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"Сохранено: {OUT}")


if __name__ == "__main__":
    main()