"""Генерирует маршруты уборки внутри дворов: параллельные проходы, не периметр."""
import argparse
import json
import math
from pathlib import Path
from shapely.geometry import shape, LineString

ROOT = Path(__file__).resolve().parents[1]
OUT_TRACK_DIR = ROOT / "work" / "smm_tracks"
SRC = ROOT / "smm.geojson"


def bearing(p1, p2):
    dx = (p2[0] - p1[0]) * math.cos(math.radians((p1[1] + p2[1]) / 2))
    dy = p2[1] - p1[1]
    return (math.degrees(math.atan2(dx, dy)) + 360) % 360


def route_passes(geometry):
    """Полосы внутри полигона; соединены короткими разворотами внутри двора."""
    yard = shape(geometry)
    inner = yard.buffer(-4 / 111320)
    if inner.is_empty:
        inner = yard.buffer(-2 / 111320)
    if inner.is_empty:
        inner = yard
    if inner.geom_type == "MultiPolygon":
        inner = max(inner.geoms, key=lambda g: g.area)
    minx, miny, maxx, maxy = inner.bounds
    width_m = (maxx - minx) * 111320 * math.cos(math.radians((miny + maxy) / 2))
    height_m = (maxy - miny) * 111320
    # Для узких дворов используем длинную ось; для широких — горизонтальные проходы.
    horizontal = width_m >= height_m
    spacing = 12 / 111320
    if horizontal:
        values = [miny + spacing * 0.5 + i * spacing for i in range(max(1, int(height_m / 12)))]
    else:
        spacing = 12 / (111320 * math.cos(math.radians((miny + maxy) / 2)))
        values = [minx + spacing * 0.5 + i * spacing for i in range(max(1, int(width_m / 12)))]
    lines = []
    for value in values:
        if horizontal:
            probe = LineString([(minx - 1e-4, value), (maxx + 1e-4, value)])
        else:
            probe = LineString([(value, miny - 1e-4), (value, maxy + 1e-4)])
        clipped = probe.intersection(inner)
        parts = list(clipped.geoms) if clipped.geom_type == "MultiLineString" else ([clipped] if clipped.geom_type == "LineString" else [])
        if not parts:
            continue
        part = max(parts, key=lambda g: g.length)
        coords = list(part.coords)
        if not horizontal:
            coords = coords if len(lines) % 2 == 0 else coords[::-1]
        else:
            coords = coords if len(lines) % 2 == 0 else coords[::-1]
        lines.append(coords)
    if not lines:
        return [[list(p) for p in inner.exterior.coords]]
    route = []
    for i, line in enumerate(lines):
        if route:
            # Разворот по ближайшим концам; обе линии находятся внутри одного буфера.
            route.append(list(line[0]))
        route.extend([list(p) for p in line])
    return route


def make_nozzle(route, yard):
    centroid = shape(yard).centroid
    result = []
    step = max(1, len(route) // 24)
    for i in range(0, len(route), step):
        p = route[i]
        b = bearing(p, [centroid.x, centroid.y])
        result.append([round(p[0], 8), round(p[1], 8), round(b, 1)])
    return result


def write_files(variant, route, nozzle, out):
    body = ''.join(f'<trkpt lat="{p[1]:.8f}" lon="{p[0]:.8f}"/>' for p in route)
    (out / f'{variant}.gpx').write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="karta-sao-smm" xmlns="http://www.topografix.com/GPX/1/1">\n'
        f'<trk><name>{variant}</name><trkseg>{body}</trkseg></trk>\n</gpx>\n', encoding='utf-8')
    (out / f'{variant}.nozzle.json').write_text(json.dumps({
        'points': nozzle,
        'source_note': 'Маршрут внутри двора: параллельные проходы уборки, без выхода на проезжую часть.'
    }, ensure_ascii=False, indent=1), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--src', default=str(SRC))
    parser.add_argument('--out-track-dir', default=str(OUT_TRACK_DIR))
    args = parser.parse_args()
    out = Path(args.out_track_dir); out.mkdir(parents=True, exist_ok=True)
    data = json.loads(Path(args.src).read_text(encoding='utf-8'))
    for feature in data['features']:
        variant = feature['id'].removeprefix('smm-')
        route = route_passes(feature['geometry'])
        nozzle = make_nozzle(route, feature['geometry'])
        write_files(variant, route, nozzle, out)
        print(f'{variant}: {len(route)} точек движения, {len(nozzle)} стрелок сопла')

if __name__ == '__main__':
    main()
