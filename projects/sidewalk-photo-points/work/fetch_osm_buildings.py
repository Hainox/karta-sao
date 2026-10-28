"""Контуры домов и точки подъездов из OpenStreetMap для района (API OSM, квадратами 8×8).

Запуск:  python3 fetch_osm_buildings.py dmitrovskiy
Результат: osm_buildings_<slug>.json рядом со скриптом.
"""
import json
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
WORK = Path(__file__).resolve().parent
GRID = 8


def bbox(slug):
    xs, ys = [], []

    def visit(c):
        if isinstance(c[0], (int, float)):
            xs.append(c[0])
            ys.append(c[1])
        else:
            for x in c:
                visit(x)
    data = json.loads((ROOT / "districts" / "layers" / slug / "boundary.geojson").read_text(encoding="utf-8"))
    for f in data["features"]:
        visit(f["geometry"]["coordinates"])
    pad = 0.003
    return min(ys) - pad, min(xs) - pad, max(ys) + pad, max(xs) + pad


def join_rings(parts):
    """Склеивает линии внешних стен в замкнутые контуры (список ссылок на узлы)."""
    parts = [list(p) for p in parts if p]
    rings = []
    while parts:
        ring = parts.pop(0)
        while ring[0] != ring[-1]:
            for i, p in enumerate(parts):
                if p[0] == ring[-1]:
                    ring += p[1:]
                elif p[-1] == ring[-1]:
                    ring += p[::-1][1:]
                else:
                    continue
                parts.pop(i)
                break
            else:
                break
        if ring[0] == ring[-1] and len(ring) >= 4:
            rings.append(ring)
    return rings


def fetch(slug):
    S, W, N, E = bbox(slug)
    nodes, ways, entrances, all_ways, relations = {}, {}, {}, {}, {}
    for i in range(GRID):
        for j in range(GRID):
            s, n = S + (N - S) * i / GRID, S + (N - S) * (i + 1) / GRID
            w, e = W + (E - W) * j / GRID, W + (E - W) * (j + 1) / GRID
            url = f"https://api.openstreetmap.org/api/0.6/map?bbox={w},{s},{e},{n}"
            for _ in range(4):
                r = subprocess.run(["curl", "-sS", "-m", "120", "-f", url], capture_output=True)
                if r.returncode == 0:
                    break
                time.sleep(5)
            else:
                sys.exit(f"не скачан квадрат {i},{j}: {r.stderr[:200]!r}")
            root = ET.fromstring(r.stdout)
            for nd in root.iter("node"):
                nodes[nd.get("id")] = (float(nd.get("lon")), float(nd.get("lat")))
                tags = {t.get("k"): t.get("v") for t in nd.iter("tag")}
                if "entrance" in tags:
                    entrances[nd.get("id")] = {"type": "node", "id": int(nd.get("id")), "tags": tags,
                                               "lon": nodes[nd.get("id")][0], "lat": nodes[nd.get("id")][1]}
            for wy in root.iter("way"):
                tags = {t.get("k"): t.get("v") for t in wy.iter("tag")}
                all_ways[wy.get("id")] = [nd.get("ref") for nd in wy.iter("nd")]
                if "building" in tags:
                    ways[wy.get("id")] = (all_ways[wy.get("id")], tags)
            for rel in root.iter("relation"):
                tags = {t.get("k"): t.get("v") for t in rel.iter("tag")}
                if "building" in tags and tags.get("type") == "multipolygon":
                    outer = [m.get("ref") for m in rel.iter("member") if m.get("type") == "way" and m.get("role") == "outer"]
                    relations[rel.get("id")] = (outer, tags)
            print(i, j, len(ways), flush=True)
    elements = [
        {"type": "way", "id": int(wid), "tags": tags,
         "geometry": [{"lon": nodes[r][0], "lat": nodes[r][1]} for r in refs]}
        for wid, (refs, tags) in ways.items() if all(r in nodes for r in refs)
    ]
    # Дом-мультиполигон: внешние стены собираем в замкнутые контуры.
    for rid, (outer, tags) in relations.items():
        for ring in join_rings([all_ways[w] for w in outer if w in all_ways]):
            if all(r in nodes for r in ring):
                elements.append({"type": "relation", "id": int(rid), "tags": tags,
                                 "geometry": [{"lon": nodes[r][0], "lat": nodes[r][1]} for r in ring]})
    out = WORK / f"osm_buildings_{slug}.json"
    out.write_text(json.dumps({"source": "api.openstreetmap.org", "elements": elements,
                               "entrances": list(entrances.values())}), encoding="utf-8")
    print(f"{len(elements)} домов, {len(entrances)} подъездов OSM → {out.name}")


if __name__ == "__main__":
    fetch(sys.argv[1])
