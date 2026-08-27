"""Probe OSM buildings around the five SMM mockup anchors (read-only network).

Usage: python tools/probe_buildings.py
Prints, per site, the largest buildings (bbox + centroid) and named highways,
so route geometry can be placed logically on the actual ground.
"""
import json
import sys
import urllib.request

SITES = {
    "dt1": ("Новопесчаная 21", (37.5105, 55.7933, 37.5145, 55.7954)),
    "dt2": ("Дубнинская 30Б", (37.5568, 55.8759, 37.5648, 55.8789)),
    "dt3": ("Бескудниковский б-р 20", (37.5575, 55.8650, 37.5618, 55.8676)),
    "dt4": ("1-й Амбулаторный пр-д 5к1/к2", (37.5335, 55.8100, 37.5375, 55.8119)),
    "dt5": ("Старопетровский пр-д 10Б", (37.5070, 55.8222, 37.5105, 55.8237)),
}

URL = "https://overpass-api.de/api/interpreter"


def build_query():
    parts = []
    for _, (_, bb) in SITES.items():
        s, w, n, e = bb[1], bb[0], bb[3], bb[2]
        parts.append(f'way["building"]({s},{w},{n},{e});')
        parts.append(f'way["highway"]["name"]({s},{w},{n},{e});')
    return "[out:json][timeout:25];(" + "".join(parts) + ");out geom qt;"


def main():
    data = build_query().encode("utf-8")
    req = urllib.request.Request(URL, data=data, headers={"User-Agent": "karta-sao-probe/1.0"})
    with urllib.request.urlopen(req, timeout=40) as resp:
        payload = json.load(resp)

    for key, (label, bb) in SITES.items():
        west, south, east, north = bb
        ways = [
            el for el in payload["elements"]
            if el.get("type") == "way" and el.get("geometry")
            and all((south - 0.0004) <= p["lat"] <= (north + 0.0004) and (west - 0.0004) <= p["lon"] <= (east + 0.0004) for p in el["geometry"])
        ]
        buildings = [w for w in ways if "building" in w.get("tags", {})]
        highways = {}
        for w in ways:
            name = w.get("tags", {}).get("name")
            if name:
                pts = [(p["lon"], p["lat"]) for p in w["geometry"]]
                highways.setdefault(name, []).append(pts)

        def extents(w):
            xs = [p["lon"] for p in w["geometry"]]
            ys = [p["lat"] for p in w["geometry"]]
            return min(xs), min(ys), max(xs), max(ys)

        print(f"\n=== {key} · {label} ===")
        scored = sorted(buildings, key=lambda w: -(extents(w)[2] - extents(w)[0]) * (extents(w)[3] - extents(w)[1]))
        for w in scored[:6]:
            x0, y0, x1, y1 = extents(w)
            tags = w["tags"]
            print(
                f"  bldg {x0:.5f}..{x1:.5f} | {y0:.5f}..{y1:.5f}"
                f"  ({(x1-x0)*62.6e3:.0f}m x {(y1-y0)*111.32e3:.0f}m)"
                f"  addr={tags.get('addr:housenumber','-')} street={tags.get('addr:street', tags.get('name','-'))[:34]}"
            )
        for name, segments in sorted(highways.items()):
            for pts in segments:
                xs = [p[0] for p in pts]
                ys = [p[1] for p in pts]
                print(f"  way {name[:44]:44s} {min(xs):.5f}..{max(xs):.5f} | {min(ys):.5f}..{max(ys):.5f}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 - probe must degrade gracefully offline
        print(f"PROBE FAILED: {exc}", file=sys.stderr)
