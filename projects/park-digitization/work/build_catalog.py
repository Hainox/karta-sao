"""Реестр и предварительные точки парков из локальных источников."""
import argparse
from collections import defaultdict
from hashlib import sha256
import json
import math
from pathlib import Path
import re
import sys
from uuid import UUID, uuid5
from zipfile import ZipFile

from openpyxl import load_workbook
from pyproj import Geod, Transformer
from shapely import STRtree, line_merge, make_valid, set_precision, transform, union_all
from shapely.geometry import LineString, Point, mapping, shape
from shapely.prepared import prep

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'work/dts-preview'))
from geometry import axes, heading, parts

NAMESPACE = UUID('d945fb39-4d9d-4d2b-8079-fcce68a33e26')
TO_METRIC = Transformer.from_crs(4326, 32637, always_xy=True)
TO_WGS84 = Transformer.from_crs(32637, 4326, always_xy=True)
GEOD = Geod(ellps='WGS84')
STEP = 90
MODEL_RANGE = 75
ANGLE = 35
MIN_SEPARATION = 10


def json_file(path):
    return json.loads(path.read_text(encoding='utf-8'))


def metric(geometry):
    return make_valid(transform(shape(geometry), TO_METRIC.transform, interleaved=False))


def polygon(geometries):
    return union_all([part for geometry in geometries for part in parts(geometry, 'Polygon')])


def as_geometry(geometry):
    return mapping(transform(geometry, TO_WGS84.transform, interleaved=False))


def normalized(value):
    return re.sub(r'[^\w]+', '', value.lower().replace('ё', 'е').removeprefix('оо\\'))


def read_excel(path):
    book = load_workbook(path)
    register = defaultdict(list)
    for sheet in book:
        if sheet['C1'].value != 'Наименование парка':
            if any(c.value is not None for row in sheet for c in row):
                raise ValueError(f'Лист требует разбора: {sheet.title}')
            continue
        if sheet.merged_cells.ranges or len(sheet.conditional_formatting):
            raise ValueError('В книге есть объединения или условная заливка. Требуется повторная проверка формата.')
        for row in sheet.iter_rows(min_row=2, max_col=7):
            if not any(cell.value is not None for cell in row):
                continue
            number, district, name, holder, elements, source_id, asu_name = [cell.value for cell in row]
            if not (number and district and name) or any(cell.data_type == 'f' for cell in row):
                raise ValueError(f'Строка {row[0].row} требует ручной сверки.')
            marks = [cell.coordinate for cell in row if cell.fill.patternType == 'solid' and
                     cell.fill.fgColor.type == 'rgb' and cell.fill.fgColor.rgb[-6:].upper() == 'FFFF00']
            sid = str(source_id).strip() if source_id is not None else None
            if sid and not re.fullmatch(r'\d+', sid):
                raise ValueError(f'ID в строке {row[0].row} требует ручной сверки.')
            register[(district.strip(), name.strip())].append({
                'sheet': sheet.title, 'row': row[0].row, 'number': number, 'asuIdInExcel': sid,
                'asuNameInExcel': asu_name, 'holder': holder, 'elements': elements,
                'yellowCells': marks, 'hiddenRow': bool(sheet.row_dimensions[row[0].row].hidden),
                'sheetState': sheet.sheet_state,
            })
    return register


def reference_index(path):
    result = {}
    with ZipFile(path) as archive:
        for name in archive.namelist():
            if not name.endswith('.geojson'):
                continue
            collection = json.loads(archive.read(name))
            for feature in collection['features']:
                ids = str(feature['properties']['ogh_id']).split(';')
                for value in ids:
                    key = value.strip()
                    if key in result:
                        raise ValueError(f'Дублирующийся ID контура: {key}')
                    result[key] = feature
    return result


def resolve_park(district, name, rows, archive, osm):
    internal_id = uuid5(NAMESPACE, normalized(district) + '/' + normalized(name))
    ids = {row['asuIdInExcel'] for row in rows} - {None}
    absent = any(row['yellowCells'] for row in rows)
    files = {id(archive[key]): archive[key] for key in ids if key in archive}
    issues = []
    status = 'absent_in_source' if absent else 'unverified'
    geometry = None
    source = None
    asu_ids = []
    geometry_ids = set()
    if files:
        ref_names = set()
        districts = set()
        for file in files.values():
            p = file['properties']
            districts.update(d.strip() for d in p['district'].split(';'))
            geometry_ids.update(v.strip() for v in str(p['ogh_id']).split(';'))
            ref_names.update(normalized(n.strip()) for n in p['Name'].split(';'))
        expected_names = {normalized(row['asuNameInExcel']) for row in rows if row['asuNameInExcel']}
        geometry = polygon(metric(file['geometry']) for file in files.values())
        if absent:
            source = 'Исторический контур паспорта АСУ ОДС'
            issues.append('Жёлтая заливка. Номер и контур относятся к исторической версии паспорта.')
        elif any(file['properties']['status'] != 'Утвержден' for file in files.values()) or not expected_names <= ref_names:
            source = 'Архив выгрузки АСУ ОДС · сверить'
            issues.append('В архиве отличается имя, статус или версия объекта.')
        else:
            asu_ids = sorted(ids & geometry_ids)
            status = 'matched' if ids <= geometry_ids else 'unverified'
            source = 'Архив утверждённых контуров АСУ ОДС'
        if districts != {district}:
            if not absent:
                status = 'conflict'
            issues.append('Район по Excel и архиву различается. По архиву: ' + ', '.join(sorted(districts)) + '. Районный доступ закрыт до сверки.')
        if extras := geometry_ids - ids:
            issues.append('Архивный контур включает дополнительные части ' + ', '.join(sorted(extras)) + '. Уточнить границы задания.')
    elif fallback := osm.get(normalized(name)):
        geometry = polygon([metric(fallback['geometry'])])
        source = 'OpenStreetMap · ' + fallback['properties']['id'] + ' · снимок проекта 19.11.2026'
        issues.append('Контур OSM. Требуется подтвердить связь с ID АСУ ОДС из списка.')
    else:
        issues.append('Контур по доступным источникам не установлен.')
    if normalized(name) == normalized('Базрвский сквер') and '907930264' in asu_ids:
        issues.append('В исходном названии «Базрвский сквер». Отображается название из подтверждённой карточки.')
        name = 'Базовский сквер'
    return {
        'id': str(internal_id), 'district': district, 'name': name, 'asu_ids': asu_ids,
        'source_objects': rows, 'geometry': None if geometry is None else as_geometry(geometry),
        'geometry_source': source, 'registry_status': status, 'needs_review': bool(issues),
    }, geometry, issues, sorted(geometry_ids)


def load_walkable():
    paths = []
    sidewalks = []
    for folder in sorted((ROOT / 'districts/layers').iterdir()):
        for filename, output in [('paths.geojson', paths), ('sidewalks.geojson', sidewalks)]:
            source = folder / filename
            if source.is_file():
                for feature in json_file(source)['features']:
                    if feature['geometry']:
                        output.append(metric(feature['geometry']))
    return STRtree(paths), STRtree(sidewalks)


def within(tree, area):
    return [tree.geometries[i].intersection(area) for i in tree.query(area, predicate='intersects')]


def route_axes(footprints):
    # Объединение устраняет наложения исходных полигонов. Обрезанные
    # островки меньше 7 м² часто образуются на стыке двух границ.
    footprint = polygon(set_precision(shape, 0.05) for shape in footprints if shape.area > 0.3)
    result = []
    for piece in parts(footprint, 'Polygon'):
        if piece.area < 7:
            continue
        simplified = piece.simplify(0.45, preserve_topology=True)
        result.extend(axes(simplified))
    merged = line_merge(union_all(result))
    return footprint, sorted((line for line in parts(merged, 'LineString') if line.length >= 4),
                             key=lambda line: (-line.length, line.bounds))


def at(line, distance):
    return line.interpolate(distance).coords[0]


def generate(park, area, sao, water, paths, sidewalks):
    if area is None or area.is_empty:
        return [], {'axisMeters': 0, 'axisCoverage': None, 'modelTargets': 0, 'unservedLongChecks': 0}, []
    unavailable = polygon(within(water, area))
    land = area.intersection(sao).difference(unavailable)
    footprint, main = route_axes(within(paths, land))
    extra_footprint, extra = route_axes(within(sidewalks, land))
    walkable = footprint.union(extra_footprint)
    walking = prep(walkable)
    ground = prep(land.buffer(-0.03))
    line_of_sight = prep(land.buffer(2).difference(unavailable))
    lines = main or extra
    if not lines:
        return [], {'axisMeters': 0, 'axisCoverage': None, 'modelTargets': 0, 'unservedLongChecks': 0}, [
            'В доступной геометрии ДТС и тротуаров не найдено позиций, пригодных для расчёта.'
        ]
    candidates = set()
    axis_targets = set()
    checks = []
    for line in lines:
        count = max(1, math.ceil(line.length / 12))
        axis_targets.update(at(line, line.length * i / count) for i in range(count + 1))
        positions = max(1, math.ceil(line.length / 24))
        candidates.update(at(line, line.length * i / positions) for i in range(positions + 1))
        if line.length > 100:
            stops = max(1, math.ceil((line.length - 8) / STEP))
            for i in range(stops + 1):
                position = at(line, 4 + (line.length - 8) * i / stops)
                checks.append(position)
                candidates.add(position)
    # Тротуар может дать обзор внутренней дорожки или открытого участка.
    for line in extra:
        if line.length >= 22:
            candidates.add(at(line, line.length / 2))
    candidates = {c for c in candidates if walking.covers(Point(c)) and ground.covers(Point(c))}
    axis_targets = sorted(axis_targets)
    if not candidates:
        return [], {'axisMeters': round(sum(line.length for line in lines)), 'axisCoverage': 0, 'modelTargets': len(axis_targets),
                    'unservedLongChecks': len(checks)}, ['Нужна ручная проверка доступных позиций.']

    # Дополнительные обзорные цели только рядом с подтверждённой зоной прохода.
    # В крупных лесных массивах сетка без данных о проходах не изображает покрытие.
    overview = []
    axis_meters = sum(line.length for line in lines)
    sparse = area.area > 80000 and axis_meters * 70 < area.area
    if not sparse:
        low_x, low_y, high_x, high_y = land.bounds
        for x in range(math.ceil(low_x / 60) * 60, math.floor(high_x) + 1, 60):
            for y in range(math.ceil(low_y / 60) * 60, math.floor(high_y) + 1, 60):
                point = Point(x, y)
                if ground.contains(point) and walkable.distance(point) <= 40:
                    overview.append((x, y))
    targets = [*axis_targets, *overview]
    target_tree = STRtree([Point(p) for p in targets])
    points = []
    covered = 0
    axis_mask = (1 << len(axis_targets)) - 1
    accepted = []
    views = {}
    for origin in sorted(candidates):
        nearby = target_tree.query(Point(origin), predicate='dwithin', distance=MODEL_RANGE)
        rays = [(int(i), heading(origin, targets[i])) for i in nearby if math.dist(origin, targets[i]) < 0.1
                or line_of_sight.covers(LineString([origin, targets[i]]))]
        angles = set(range(0, 360, 15)) | {int(round(angle)) % 360 for _, angle in rays}
        same = sum(1 << i for i, _ in rays if math.dist(origin, targets[i]) < 1)
        views[origin] = [(angle, same | sum(1 << i for i, azimuth in rays
                                          if abs((azimuth - angle + 180) % 360 - 180) <= ANGLE))
                         for angle in sorted(angles)]

    def score(frame):
        seen = frame[1] & ~covered
        return 4 * (seen & axis_mask).bit_count() + seen.bit_count()

    def choose(origin, frame):
        nonlocal covered
        accepted.append(origin)
        angle, seen = frame
        covered |= seen
        lng, lat = TO_WGS84.transform(*origin)
        radians = math.radians(angle)
        dest = TO_WGS84.transform(origin[0] + 30 * math.sin(radians), origin[1] + 30 * math.cos(radians))
        azimuth = round(GEOD.inv(lng, lat, *dest)[0] % 360, 2) % 360
        coordinates = [round(lng, 8), round(lat, 8)]
        identifier = uuid5(UUID(park['id']), f'{coordinates[0]:.8f},{coordinates[1]:.8f}')
        points.append({'id': str(identifier), 'parkId': park['id'], 'coordinates': coordinates,
                       'slot': {'id': str(uuid5(identifier, 'frame')), 'azimuth': azimuth}})

    # На протяжённых осях сначала сохраняются позиции с шагом до 90 м.
    for origin in dict.fromkeys(checks):
        if origin in views and all(math.dist(origin, b) >= MIN_SEPARATION for b in accepted):
            frame = max(views.pop(origin), key=score)
            if frame[1]:
                choose(origin, frame)
    # Из оставшихся вариантов берём только дающие новый полезный обзор.
    while views:
        best = None
        for origin in list(views):
            if accepted and math.dist(origin, accepted[-1]) < MIN_SEPARATION:
                del views[origin]
                continue
            frame = max(views[origin], key=score)
            gain = score(frame)
            # Один новый обзорный узел сам по себе не оправдывает ещё одну
            # фотографию, если сеть уже покрыта с соседних позиций.
            if gain >= 2 and (best is None or gain > best[0]):
                best = (gain, origin, frame)
        if not best:
            break
        _, origin, frame = best
        del views[origin]
        if all(math.dist(origin, b) >= MIN_SEPARATION for b in accepted):
            choose(origin, frame)
    unresolved = [check for check in dict.fromkeys(checks)
                  if not any(math.dist(check, origin) < MIN_SEPARATION for origin in accepted)]
    checked = len(unresolved)
    covered_axis = (covered & axis_mask).bit_count()
    stats = {'axisMeters': round(axis_meters),
             'axisCoverage': round(100 * covered_axis / len(axis_targets), 1),
             'modelTargets': len(axis_targets), 'unservedLongChecks': checked,
             'checkLocations': [[round(value, 8) for value in TO_WGS84.transform(*point)] for point in unresolved]}
    issues = []
    if not main:
        issues.append('Доступных осей ДТС нет. План опирается на геометрию тротуаров.')
    if checked or covered_axis < len(axis_targets):
        issues.append('Часть расчётной сети требует ручной проверки ракурсов.')
    if sparse:
        issues.append('Малая плотность доступной сети. Проверить внутренние проходы по местности.')
    return points, stats, issues


def main():
    cli = argparse.ArgumentParser()
    cli.add_argument('excel', type=Path)
    cli.add_argument('boundaries', type=Path)
    cli.add_argument('output', type=Path)
    cli.add_argument('--pilot', action='store_true')
    args = cli.parse_args()
    source = read_excel(args.excel)
    archive = reference_index(args.boundaries)
    osm_snapshot = json_file(ROOT / 'work/dts-preview/parks-osm.geojson')
    osm = {normalized(f['properties']['name']): f for f in osm_snapshot['features']
           if f['properties']['id'] == 'relation/4012415'}
    water = STRtree([metric(f['geometry']) for f in json_file(ROOT / 'water.geojson')['features']])
    boundary = json_file(ROOT / 'photo-service/src/tpu-points/sao_boundary_wgs84.geojson')
    sao = polygon(metric(f['geometry']) for f in boundary['features'] if f['properties'].get('feature_kind') == 'boundary_sao')
    if sao.is_empty:
        sao = polygon(metric(f['geometry']) for f in boundary['features'])
    paths, sidewalks = load_walkable()
    parks, points, report = [], [], []
    for (district, name), rows in source.items():
        if args.pilot and not {'907930264', '955937614', '1099782799', '905817355'}.intersection(r['asuIdInExcel'] for r in rows):
            continue
        park, geometry, issues, geometry_ids = resolve_park(district, name, rows, archive, osm)
        found, stats, field_issues = generate(park, geometry, sao, water, paths, sidewalks)
        issues.extend(field_issues)
        park['needs_review'] = bool(issues)
        parks.append(park)
        points.extend(found)
        report.append({'parkId': park['id'], 'nameInExcel': name, 'geometryIds': geometry_ids, 'issues': issues,
                       'areaHa': round(geometry.area / 10000, 2) if geometry is not None else None,
                       'points': len(found), **stats})
        print(district, park['name'], len(found), stats, flush=True)

    out = {'version': 1, 'parks': parks, 'points': points, 'report': report,
           'sourceSha256': {'excel': sha256(args.excel.read_bytes()).hexdigest(),
                            'boundaries': sha256(args.boundaries.read_bytes()).hexdigest()}}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    print(f'Итого: {len(parks)} парков, {len(points)} точек и фотослотов.')


if __name__ == '__main__':
    main()
