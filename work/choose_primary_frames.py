# -*- coding: utf-8 -*-
"""Выбирает единственный основной кадр для каждой точки слоя «Оцифровка ДТС».

Правило (dev/BuildSpec-Yard-One-Direction-20261117.md):
  1. Для каждого существующего азимута точки измеряется непрерывный участок
     луча внутри контура дорожки с тем же sourceId, максимум 200 м. Метрическая
     система — UTM 37N (EPSG:32637); направление луча — геодезическое прямое
     решение на WGS84, поэтому расхождение с сеткой UTM учтено.
  2. Основным становится кадр с наибольшим обзором; при различии до 1 м
     сохраняется исходный порядок кадров.
  3. Автоматический выбор применяется, если точка внутри контура и обзор не
     менее 5 м. Иначе (нет контура, точка вне контура, все обзоры короче 5 м)
     — первый исходный кадр и метка «Направление требует проверки на месте».
  4. Ручной выбор префектуры в primary_frames.json переживает пересборку.

Вход:  снимок каталога с API фотослужбы (version 1, singleFrame true,
       points[...]) — например, work/dts-preview/data/catalog.json;
       и districts/layers/*/paths.geojson (контур дорожки — property «id»).
Выход: primary_frames.json (рядом со скриптом):
  { version: 1, updatedAt, catalogSha256,
    points: [point_id], review: [point_id],
    frames: { point_id: { slot_id, azimuth, reason, view_m } } }

Команды:
  python choose_primary_frames.py КАРТА_KATALOG.JSON
      (пересобирает primary_frames.json и печатает сводку)
  python choose_primary_frames.py --check КАРТА_KATALOG.JSON
      (сравнивает пересборку с сохранённым файлом; ненулевой выход при расхождении)
  python choose_primary_frames.py --build КАРТА_KATALOG.JSON ВЫХОД.json
      (пишет однокадровый каталог: singleFrame true, по одному слоту на точку)
"""
import argparse
import hashlib
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from pyproj import Geod, Transformer
from shapely import transform, union_all
from shapely.geometry import Point
from shapely.geometry import shape

HERE = Path(__file__).resolve().parent
LAYERS = HERE.parent / 'districts' / 'layers'
PRIMARY_PATH = HERE / 'primary_frames.json'

VERSION = 1
MAX_VIEW = 200.0   # м, предел протяжки луча
MIN_VIEW = 5.0     # м, порог «обзор достаточен для автоматического выбора»
TOLERANCE = 1.0    # м, допуск сравнения обзора: исходный порядок важнее точности
REVIEW_LABEL = 'Направление требует проверки на месте'
FORWARD_DISTANCE = 100.0  # м, пролёт для определения направления луча в метрической системе

WGS84_TO_METRIC = Transformer.from_crs(4326, 32637, always_xy=True)
GEOD = Geod(ellps='WGS84')


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def to_metric(x, y):
    return WGS84_TO_METRIC.transform(x, y)


def to_metric_coords(coords):
    """shapely transformation: (N,2) массив → (N,2) массив в метрах."""
    x, y = WGS84_TO_METRIC.transform(np.asarray(coords)[:, 0], np.asarray(coords)[:, 1])
    return np.stack([x, y], axis=1)


class PathIndex:
    """(district, sourceId) → метрический полигон и список его контурных отрезков."""

    def __init__(self):
        self._cache = {}

    def polygon(self, district, source_id):
        key = (district, str(source_id))
        cached = self._cache.get(key, None)
        if cached is not None:
            return cached
        found = []
        district_dir = LAYERS / _slug(district)
        path = district_dir / 'paths.geojson'
        if path.is_file():
            for feature in load(path)['features']:
                if str(feature['properties'].get('id')) != key[1]:
                    continue
                polygon = shape(feature['geometry'])
                if not polygon.is_empty:
                    found.append(polygon)
        if not found:
            self._cache[key] = None
            return None
        metric_poly = transform(found[0], to_metric_coords)
        if len(found) > 1:
            metric_poly = union_all([transform(p, to_metric_coords) for p in found])
        rings = _rings_of(metric_poly)
        segments = []
        for ring in rings:
            coords = list(ring.coords)
            for (a, b) in zip(coords, coords[1:]):
                segments.append(((a[0], a[1]), (b[0], b[1])))
        result = (metric_poly, segments)
        self._cache[key] = result
        return result


def _slug(district):
    return {
        'Аэропорт': 'aeroport', 'Беговой': 'begovoy', 'Бескудниковский': 'beskudnikovskiy',
        'Войковский': 'voykovskiy', 'Восточное Дегунино': 'vostochnoe-degunino',
        'Головинский': 'golovinskiy', 'Дмитровский': 'dmitrovskiy',
        'Западное Дегунино': 'zapadnoe-degunino', 'Коптево': 'koptevo',
        'Левобережный': 'levoberezhnyy', 'Молжаниновский': 'molzhaninovskiy',
        'Савеловский': 'savelovskiy', 'Сокол': 'sokol', 'Тимирязевский': 'timiryazevskiy',
        'Ховрино': 'hovrino', 'Хорошевский': 'horoshevskiy',
    }[district]


def _rings_of(polygon):
    if polygon.geom_type == 'MultiPolygon':
        return [p.exterior for p in polygon.geoms] + [r for p in polygon.geoms for r in list(p.interiors)]
    return [polygon.exterior] + list(polygon.interiors)


def ray_direction(lng, lat, azimuth):
    """Единичный вектор луча в метрической системе по геодезическому азимуту."""
    fx, fy = to_metric(lng, lat)
    _, _, _, _, dx, dy = GEOD.fwd(lng, lat, azimuth, FORWARD_DISTANCE)
    gx, gy = to_metric(dx, dy)
    scale = math.hypot(gx - fx, gy - fy)
    if scale < 1e-9:
        rad = math.radians(azimuth)
        return math.sin(rad), math.cos(rad)
    return (gx - fx) / scale, (gy - fy) / scale


def ray_view(m_poly, segments, x, y, dx, dy):
    """Непрерывная длина участка луча внутри полигона, 0..MAX_VIEW."""
    box = m_poly.bounds
    stops = []
    if abs(dx) > 1e-12:
        stops += [(x - box[0]) / dx, (box[2] - x) / dx]
    if abs(dy) > 1e-12:
        stops += [(y - box[1]) / dy, (box[3] - y) / dy]
    stop = min((t for t in stops if t > 1e-9), default=math.inf)
    stop = min(stop, MAX_VIEW)
    if stop <= 0:
        return 0.0
    inside = m_poly.covers(Point(x, y))
    ts = set()
    for (x1, y1), (x2, y2) in segments:
        sx, sy = x2 - x1, y2 - y1
        denom = dx * sy - dy * sx
        if abs(denom) < 1e-12:
            continue
        t = ((x1 - x) * sy - (y1 - y) * sx) / denom
        if t <= 1e-9 or t > stop:
            continue
        u = ((x1 - x) * dy - (y1 - y) * dx) / denom
        if -1e-9 <= u <= 1 + 1e-9:
            ts.add(round(t, 6))
    length = 0.0
    prev = 0.0
    for t in sorted(ts):
        if inside:
            length += t - prev
            if length >= MAX_VIEW:
                return MAX_VIEW
        inside = not inside
        prev = t
    if inside:
        length += stop - prev
    return min(length, MAX_VIEW)


def choose(point, index):
    """Основной кадр точки: (slot, reason, view_m)."""
    slots = point['slots']
    first = slots[0]
    matched = index.polygon(point['district'], point['sourceId'])
    if matched is None:
        return first, 'no_contour', 0.0
    m_poly, segments = matched
    lng, lat = point['coordinates']
    x, y = to_metric(lng, lat)
    if not m_poly.covers(Point(x, y)):
        return first, 'outside_contour', 0.0
    best_slot, best_length = first, -1.0
    for slot in slots:
        dx, dy = ray_direction(lng, lat, slot['azimuth'])
        length = ray_view(m_poly, segments, x, y, dx, dy)
        # Допуск 1 м: исходный порядок кадров решает ничью.
        if length - best_length > TOLERANCE:
            best_slot, best_length = slot, length
    if best_length < MIN_VIEW:
        return first, 'short_view', max(0.0, best_length)
    return best_slot, 'longest_view', best_length


def build_primary(catalog_points):
    index = PathIndex()
    previous = {}
    if PRIMARY_PATH.is_file():
        previous = load(PRIMARY_PATH).get('frames', {})
    frames, review = {}, []
    reasons = {}
    for point in catalog_points:
        slot, reason, view = choose(point, index)
        manual = previous.get(point['id'])
        if manual and any(s['id'] == manual.get('slot_id') for s in point['slots']):
            slot, reason, view = manual['slot_id'], 'manual', manual.get('view_m', view)
        frames[point['id']] = {'slot_id': slot['id'], 'azimuth': slot['azimuth'],
                               'reason': reason, 'view_m': round(view, 2)}
        reasons[reason] = reasons.get(reason, 0) + 1
        if reason != 'longest_view' and reason != 'manual':
            review.append(point['id'])
    return frames, review, reasons


def main(argv=None):
    cli = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    cli.add_argument('catalog', type=Path)
    cli.add_argument('--check', action='store_true',
                     help='сравнить пересборку с сохранённым primary_frames.json')
    cli.add_argument('--build', type=Path, metavar='OUTPUT',
                     help='написать однокадровый каталог в OUTPUT')
    args = cli.parse_args(argv)
    catalog_raw = args.catalog.read_bytes()
    catalog = json.loads(catalog_raw.decode('utf-8-sig'))
    if catalog.get('version') != 1:
        sys.exit('Каталог не version 1: отказываюсь менять назначение кадров.')
    points = catalog['points']
    assert len({p['id'] for p in points}) == len(points), 'дубли id точек'
    assert all(1 <= len(p['slots']) <= 6 for p in points), 'у точки вне диапазона 1..6 слотов'
    frames, review, reasons = build_primary(points)
    payload = {
        'version': VERSION,
        'updatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'catalogSha256': sha256_bytes(catalog_raw),
        'points': sorted(frames),
        'review': sorted(review),
        'frames': frames,
    }
    if args.check:
        if not PRIMARY_PATH.is_file():
            sys.exit('Сохранённый primary_frames.json не найден; сначала пересоберите без --check.')
        saved = load(PRIMARY_PATH)
        if saved.get('frames') != payload['frames']:
            for point_id in sorted(set(saved.get('frames', {})) | set(frames)):
                a, b = saved.get('frames', {}).get(point_id), frames.get(point_id)
                if a != b:
                    print('расхождение', point_id, a, '->', b)
            sys.exit('Пересборка не совпадает с сохранённым primary_frames.json.')
        print('primary_frames.json совпадает с пересборкой:', len(frames), 'точек,',
              len(review), 'на проверке')
        return
    PRIMARY_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding='utf-8')
    print('primary_frames.json:', len(frames), 'точек;',
          {k: v for k, v in sorted(reasons.items())}, ';',
          len(review), 'требуют проверки направления')
    if args.build:
        by_id = {p['id']: p for p in points}
        out_points = []
        for point in points:
            frame = frames[point['id']]
            slot = next(s for s in point['slots'] if s['id'] == frame['slot_id'])
            entry = {k: v for k, v in point.items() if k != 'slots'}
            review_point = point['id'] in set(review)
            if review_point:
                entry['review'] = REVIEW_LABEL
            entry['slots'] = [dict(slot)]
            out_points.append(entry)
        out = {'version': 1, 'singleFrame': True, 'catalogSha256': sha256_bytes(catalog_raw),
               'generatedAt': payload['updatedAt'], 'points': out_points}
        assert all(len(p['slots']) == 1 for p in out_points)
        args.build.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        print(args.build, len(out_points), 'точек,',
              sum(len(p['slots']) for p in out_points), 'кадров,',
              len(set(review)), 'с меткой проверки направления')


if __name__ == '__main__':
    main()
