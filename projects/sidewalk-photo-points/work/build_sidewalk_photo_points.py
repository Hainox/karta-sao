"""Черновая расстановка точек съёмки тротуаров у МКД (тестовый вариант).

Правила (по образцам префектуры и по тому, как сотрудники правили черновики,
выгрузка photo-service/scripts/export-sidewalk-edits.js → staff_edits.txt):
- снимаются тротуары дворовых территорий (АСУ ОДС, тротуар в составе двора,
  parent_type_id 38); тротуары ОДХ не берутся;
- ориентир — сторона подъездов: для каждого фасада с подъездами две точки
  у двух углов дома, взгляд вдоль фасада к дому, чтобы кадр охватывал весь
  тротуар перед подъездами; длинный фасад делится промежуточными точками;
- фотограф стоит не у стены, а на внешней кромке тротуара или на дворовом
  проезде за ней (не на газоне и не на парковке), в 8–12 м от стены и в 6 м
  за углом дома: так сотрудники переносили черновики (медиана — 9–11 м от стены);
- если вдоль задней стороны дома тоже идёт дворовый тротуар, у неё ставятся
  такие же две точки; если тротуар обходит дом кругом — точки у остальных углов;
- с --staff правки префектуры сохраняются: перенесённые, повёрнутые
  и добавленные точки входят в слой со своими номерами; рядом с ними (если взгляд
  похожий) и там, где префектура точку удалила, новые не ставятся; новые точки нумеруются
  с --first, чтобы не совпасть ни с одним выданным номером.

Источники: подъезды — object-maps/data/entrances.json, контуры домов —
OpenStreetMap (скачиваются заранее fetch_osm_buildings.py в
osm_buildings_<slug>.json); если в OSM подъезд отмечен точкой на стене дома,
сторона фасада берётся по ней, иначе по координатам реестра,
тротуары и дворы — districts/layers/<slug>/.

Запуск:  python3 build_sidewalk_photo_points.py dmitrovskiy
         python3 build_sidewalk_photo_points.py aeroport --staff=staff_edits.txt --first=501
Результат: districts/layers/<slug>/sidewalk_shoot.geojson
"""
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

from shapely.geometry import LineString, Point, Polygon, box, shape
from shapely.ops import nearest_points, unary_union
from shapely.strtree import STRtree
from shapely import affinity

ROOT = Path(__file__).resolve().parents[3]
WORK = Path(__file__).resolve().parent

SLUGS = {
    "aeroport": "Аэропорт", "begovoy": "Беговой", "beskudnikovskiy": "Бескудниковский",
    "voykovskiy": "Войковский", "vostochnoe-degunino": "Восточное Дегунино",
    "golovinskiy": "Головинский", "dmitrovskiy": "Дмитровский",
    "zapadnoe-degunino": "Западное Дегунино", "koptevo": "Коптево",
    "levoberezhnyy": "Левобережный", "molzhaninovskiy": "Молжаниновский",
    "savelovskiy": "Савеловский", "sokol": "Сокол", "timiryazevskiy": "Тимирязевский",
    "hovrino": "Ховрино", "horoshevskiy": "Хорошевский",
}
DISTRICT_NOS = {slug: str(no) for no, slug in enumerate(SLUGS, 1)}

ENTRANCE_TO_BUILDING_M = 12   # подъезд дальше — дом не найден
FACADE_ANGLE_DEG = 20         # подъезды на рёбрах с таким разбросом — один фасад
FACADE_OFFSET_M = 15          # и не дальше друг от друга по нормали (ступенчатый фасад)
BAND_DEPTH_M = 25             # полоса тротуара перед фасадом
CORNER_OVERSHOOT_M = 6        # точка за углом дома
SNAP_MAX_M = 15               # дальше от тротуара — точку не ставим
LONG_FACADE_M = 100           # длиннее — добавляем промежуточные точки
CAMERA_MIN_M = 8              # фотограф не ближе этого к стене:
CAMERA_MAX_M = 12             # внешняя кромка тротуара + 1 м, но в этих пределах
CAMERA_TO_WALK_M = 8          # и не дальше этого от снимаемого тротуара
BACK_SIDE_SHARE = 0.6         # доля задней стены с тротуаром — ставим точки и там
STAFF_KEEP_M = 15             # ближе к точке префектуры с похожим взглядом (±60°) новую не ставим,
STAFF_SAME_M = 6              # а ближе этого — при любом взгляде
STAFF_DELETED_M = 12          # и ближе к удалённой префектурой
MERGE_M = 12                  # ближе — одна точка
MIN_WALL_M = 5                # короче — уступ, а не стена
ROW_MIN_SPREAD_M = 10         # подъезды «в линию»: разброс вдоль оси не меньше
ROW_MAX_WIDTH_M = 8           # и поперёк не больше
OSM_DOOR_M = 25               # подъезд реестра ищем на стене OSM в этом радиусе
END_CAP_M = 30                # точка — не дальше этого за первым/последним подъездом
MIN_BEYOND_M = 6              # и не ближе этого
RING_SHARE = 0.8              # доля периметра с тротуаром для «кругового» дома


class Local:
    """Плоские метры вокруг района: x — восток, y — север."""

    def __init__(self, lon0, lat0):
        self.lon0, self.lat0 = lon0, lat0
        self.kx = 111320 * math.cos(math.radians(lat0))
        self.ky = 110540

    def xy(self, lon, lat):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)

    def lonlat(self, x, y):
        return (round(self.lon0 + x / self.kx, 7), round(self.lat0 + y / self.ky, 7))

    def geom(self, g):
        def conv(coords):
            return [self.xy(*c[:2]) for c in coords]
        if g.geom_type == "Polygon":
            # buffer(0) чинит самопересечения контуров из АСУ ОДС.
            return Polygon(conv(g.exterior.coords), [conv(r.coords) for r in g.interiors]).buffer(0)
        if g.geom_type == "MultiPolygon":
            return unary_union([self.geom(p) for p in g.geoms])
        raise ValueError(g.geom_type)


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def azimuth(vx, vy):
    return round((math.degrees(math.atan2(vx, vy)) + 360) % 360) % 360


def entrance_range(numbers):
    nums = sorted({n for n in numbers if isinstance(n, int)})
    if not nums:
        return ""
    parts, start, prev = [], nums[0], nums[0]
    for n in nums[1:] + [None]:
        if n is not None and n == prev + 1:
            prev = n
            continue
        parts.append(str(start) if start == prev else f"{start}–{prev}")
        if n is not None:
            start = prev = n
    return ", ".join(parts)


def main_axes(poly):
    """Две главные оси дома — стороны описанного прямоугольника (единичные векторы)."""
    rect = list(poly.minimum_rotated_rectangle.exterior.coords)
    axes = []
    for a, b in (rect[0:2], rect[1:3]):
        ln = math.hypot(b[0] - a[0], b[1] - a[1]) or 1
        axes.append(((b[0] - a[0]) / ln, (b[1] - a[1]) / ln))
    return axes


def nearest_edge(poly, p):
    """Ближайшая к точке стена дома: (a, b, расстояние, ось фасада).

    Короткие уступы и косые срезы углов не считаются стеной: берём рёбра
    длиннее MIN_WALL_M, идущие вдоль одной из главных осей дома, и
    направление фасада — саму ось.
    """
    axes = main_axes(poly)
    walls = []
    coords = list(poly.exterior.coords)
    for a, b in zip(coords, coords[1:]):
        ex, ey = b[0] - a[0], b[1] - a[1]
        ln = math.hypot(ex, ey)
        if ln < MIN_WALL_M:
            continue
        axis = max(axes, key=lambda u: abs(u[0] * ex + u[1] * ey) / ln)
        if abs(axis[0] * ex + axis[1] * ey) / ln < math.cos(math.radians(FACADE_ANGLE_DEG)):
            continue
        walls.append((a, b, LineString([a, b]).distance(p), axis, ln))
    if not walls:
        return None
    # Подъезд во внутреннем углу уступа: из почти равноудалённых стен берём длинную.
    nearest = min(w[2] for w in walls)
    a, b, d, axis, _ = max((w for w in walls if w[2] < nearest + 1), key=lambda w: w[4])
    return a, b, d, axis


def entrance_row(bld, ents, yard_walks):
    """Линейный дом: подъезды стоят в одну линию.

    Фасад задаёт линия от первого подъезда к последнему (по номеру); если она
    почти совпадает с осью дома — берём ось. Сторона подъездов — по стене дома,
    у которой стоят подъезды, иначе по смещению линии от центра дома, а без
    контура дома — по ближайшему дворовому тротуару.
    """
    if len(ents) < 2:
        return []
    numbered = sorted(ents, key=lambda e: (e[1]["properties"].get("№ подъезда") or 0))
    (p0, _), (p1, _) = numbered[0], numbered[-1]
    length = math.dist((p0.x, p0.y), (p1.x, p1.y))
    if length < ROW_MIN_SPREAD_M:
        return []
    ux, uy = (p1.x - p0.x) / length, (p1.y - p0.y) / length
    if bld is not None:
        for ax, ay in main_axes(bld):
            dot = ux * ax + uy * ay
            if abs(dot) >= math.cos(math.radians(FACADE_ANGLE_DEG)):
                ux, uy = (ax, ay) if dot > 0 else (-ax, -ay)
                break
    nx, ny = uy, -ux
    mx = sum(pt.x for pt, _ in ents) / len(ents)
    my = sum(pt.y for pt, _ in ents) / len(ents)
    across = [(pt.x - mx) * nx + (pt.y - my) * ny for pt, _ in ents]
    if max(across) - min(across) > ROW_MAX_WIDTH_M:
        return []
    side = 0.0
    if bld is not None:
        for pt, _ in ents:
            edge = nearest_edge(bld, pt)
            if edge is None or edge[2] > ENTRANCE_TO_BUILDING_M:
                continue
            a, b, _, _ = edge
            mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
            outward = 1 if not bld.contains(Point(mid[0] + nx * 1.5, mid[1] + ny * 1.5)) else -1
            # Стена вдоль фасада голосует за сторону; торцевые стены не в счёт.
            ex, ey = b[0] - a[0], b[1] - a[1]
            if abs(ex * ux + ey * uy) >= 0.8 * math.hypot(ex, ey):
                side += outward
        if side == 0:
            c = bld.centroid
            side = (mx - c.x) * nx + (my - c.y) * ny
    else:
        offs = []
        for pt, _ in ents:
            q = nearest_points(yard_walks, pt)[0]
            if q.distance(pt) < 25:
                offs.append((q.x - pt.x) * nx + (q.y - pt.y) * ny)
        side = sorted(offs)[len(offs) // 2] if offs else 0.0
    if side == 0:
        return []
    if side < 0:
        nx, ny = -nx, -ny
    # Тротуар ищем сразу от линии подъездов: у ступенчатого фасада он лежит ближе
    # самого выступающего края дома; сам дом из полосы поиска вычитается.
    return [{"u": (ux, uy), "n": (nx, ny), "ox": mx, "oy": my, "ents": list(ents)}]


def read_staff_edits(path, district_no):
    """Правки префектуры одного района из выгрузки export-sidewalk-edits.js:
    {номер: (долгота, широта, направление, отметки)}; D — удалена, A — добавлена."""
    edits = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if not line.startswith("Т"):
            continue
        no, lng, lat, heading, flags = line.split(";")
        if no[1:].split(".")[0] == district_no:
            edits[no] = (float(lng), float(lat), int(heading), flags)
    return edits


def build(slug, staff=None, first_no=1):
    district = SLUGS[slug]
    layers = ROOT / "districts" / "layers" / slug
    boundary = shape(load(layers / "boundary.geojson")["features"][0]["geometry"])
    c = boundary.centroid
    L = Local(c.x, c.y)
    boundary_m = L.geom(boundary)

    sidewalks = [L.geom(shape(f["geometry"])) for f in load(layers / "sidewalks.geojson")["features"]
                 if f["properties"].get("parent_type_id") == 38]
    # Участки, где дворовый тротуар заходит на ОДХ или проезд, исключаем.
    roads = [L.geom(shape(f["geometry"]).buffer(0)) for name in ("driveways", "odh")
             for f in load(layers / f"{name}.geojson")["features"]]
    yard_walks = unary_union(sidewalks).buffer(0).difference(unary_union(roads).buffer(1))
    yards = unary_union([L.geom(shape(f["geometry"])) for f in load(layers / "yards.geojson")["features"]]).buffer(3)
    driveways = unary_union([L.geom(shape(f["geometry"]).buffer(0)) for f in load(layers / "driveways.geojson")["features"]]).buffer(0)
    odh = unary_union([L.geom(shape(f["geometry"]).buffer(0)) for f in load(layers / "odh.geojson")["features"]]).buffer(0)
    parking = unary_union([L.geom(shape(f["geometry"]).buffer(0)) for f in load(layers / "parking.geojson")["features"]]).buffer(0)

    buildings = []
    for el in load(WORK / f"osm_buildings_{slug}.json")["elements"]:
        geom = el.get("geometry") or []
        if len(geom) < 4 or geom[0] != geom[-1]:
            continue
        poly = Polygon([L.xy(g["lon"], g["lat"]) for g in geom]).buffer(0)
        if poly.is_empty or poly.area < 60 or poly.geom_type != "Polygon":
            continue
        buildings.append(poly.simplify(0.8))
    tree = STRtree(buildings)
    bld_union = unary_union(buildings)

    def camera(target, home, walk):
        """Место фотографа: от target шагами по метру к home (точке на тротуаре), пока
        место не окажется во дворе на тротуаре или дворовом проезде — не на газоне,
        не в доме, не на ОДХ и не на парковке — и не дальше CAMERA_TO_WALK_M от
        снимаемого тротуара walk. None — подходящего места нет."""
        dist = target.distance(home)
        for k in range(int(dist) + 1):
            t = k / dist if dist else 0
            q = Point(target.x + (home.x - target.x) * t, target.y + (home.y - target.y) * t)
            if ((yard_walks.distance(q) < 0.5 or driveways.contains(q)) and walk.distance(q) <= CAMERA_TO_WALK_M
                    and yards.contains(q) and boundary_m.contains(q) and not bld_union.intersects(q.buffer(0.7))
                    and not odh.contains(q) and not parking.contains(q)):
                return q
        return None

    def far_edge(walk, ox, oy, ux, uy, nx, ny, alongs, default):
        """Внешняя кромка тротуара: медиана дальнего от фасада края по поперечным лучам."""
        fars = []
        for a in alongs:
            sx, sy = ox + ux * a, oy + uy * a
            hit = walk.intersection(LineString([(sx, sy), (sx + nx * BAND_DEPTH_M, sy + ny * BAND_DEPTH_M)]))
            if not hit.is_empty:
                fars.append(max((x - ox) * nx + (y - oy) * ny for g in getattr(hit, "geoms", [hit]) for x, y in g.coords))
        return sorted(fars)[len(fars) // 2] if fars else default

    def place(walk, ox, oy, ux, uy, nx, ny, a, d_walk, d_cam):
        """Точка съёмки у отметки a вдоль фасада. Сначала — ближайшее место на тротуаре
        (как раньше), затем фотограф отходит от стены до d_cam: на внешнюю кромку или
        на проезд за ней; если там газон, пробуем сдвинуться на 3–6 м вдоль дома."""
        home = Point(ox + ux * a + nx * d_walk, oy + uy * a + ny * d_walk)
        base = home if walk.contains(home) else nearest_points(walk, home)[0]
        if base.distance(home) > SNAP_MAX_M:
            return None
        off = (base.x - ox) * nx + (base.y - oy) * ny
        for da in (0, -3, 3, -6, 6):
            bx, by = base.x + ux * da, base.y + uy * da
            q = camera(Point(bx + nx * max(d_cam - off, 0), by + ny * max(d_cam - off, 0)), Point(bx, by), walk)
            if q is not None:
                return q
        return base

    osm_doors = [(Point(L.xy(e["lon"], e["lat"])), e["tags"]) for e in load(WORK / f"osm_buildings_{slug}.json").get("entrances", [])
                 if e["tags"].get("entrance") in ("staircase", "main", "yes")]

    houses = defaultdict(list)
    for r in load(ROOT / "object-maps" / "data" / "entrances.json")["records"]:
        if r["group"] != district:
            continue
        p = r["properties"]
        houses[p.get("УНОМ") or p.get("Адрес")].append(r)

    points, stats = [], Counter()
    for unom, recs in houses.items():
        stats["houses"] += 1
        ents = [(Point(L.xy(r["lon"], r["lat"])), r) for r in recs]
        votes = Counter()
        for pt, _ in ents:
            idx = tree.query_nearest(pt, max_distance=ENTRANCE_TO_BUILDING_M)
            if len(idx):
                votes[int(idx[0])] += 1
        bld = buildings[votes.most_common(1)[0][0]] if votes else None
        stats["no_building"] += bld is None
        address = recs[0]["properties"].get("Адрес", "")

        # Подъезд реестра → точка подъезда OSM на стене того же дома (по номеру, иначе ближайшая).
        if bld is not None:
            snapped = []
            for pt, r in ents:
                near = [(d, pt2, tags) for pt2, tags in osm_doors
                        if (d := pt2.distance(pt)) < OSM_DOOR_M and bld.exterior.distance(pt2) < 1.5]
                same = [x for x in near if str(x[2].get("ref", "")).strip() == str(r["properties"].get("№ подъезда"))]
                best = min(same or near, key=lambda x: x[0], default=None)
                snapped.append((best[1], r) if best else (pt, r))
            stats["entrances_on_osm_wall"] += sum(1 for (a, _), (b, _) in zip(snapped, ents) if a is not b)
            ents = snapped
        stats["entrances"] += len(ents)

        # Обычный линейный дом: подъезды в одну линию — фасад задают первый и последний подъезд.
        facades = entrance_row(bld, ents, yard_walks)
        if facades:
            stats["houses_row"] += 1
        elif bld is not None:
            # Нестандартный дом: подъезды по сторонам дома (ближайшая стена, нормаль наружу).
            stats["houses_by_walls"] += 1
            for pt, r in ents:
                edge = nearest_edge(bld, pt)
                if edge is None or edge[2] > ENTRANCE_TO_BUILDING_M:
                    continue
                a, b, _, (ux, uy) = edge
                nx, ny = uy, -ux
                mid = ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)
                if bld.contains(Point(mid[0] + nx * 1.5, mid[1] + ny * 1.5)):
                    nx, ny = -nx, -ny
                foot = LineString([a, b]).interpolate(LineString([a, b]).project(pt))
                ang = math.degrees(math.atan2(uy, ux)) % 180
                for fac in facades:
                    dang = abs(fac["ang"] - ang)
                    dang = min(dang, 180 - dang)
                    off = (foot.x - fac["ox"]) * fac["n"][0] + (foot.y - fac["oy"]) * fac["n"][1]
                    if dang < FACADE_ANGLE_DEG and abs(off) < FACADE_OFFSET_M and fac["n"][0] * nx + fac["n"][1] * ny > 0:
                        fac["ents"].append((pt, r))
                        break
                else:
                    facades.append({"ang": ang, "u": (ux, uy), "n": (nx, ny), "ox": foot.x, "oy": foot.y, "ents": [(pt, r)]})
        else:
            stats["skipped_no_building_not_row"] += 1

        house_points = []
        for fac in facades:
            ux, uy = fac["u"]
            nx, ny = fac["n"]
            ox, oy = fac["ox"], fac["oy"]
            # Первый и последний подъезд стороны по номеру; точки — за ними, у торцов дома.
            numbered = sorted(fac["ents"], key=lambda e: (e[1]["properties"].get("№ подъезда") or 0))
            first, last = numbered[0], numbered[-1]
            proj = lambda pt: (pt.x - ox) * ux + (pt.y - oy) * uy
            lo, hi = sorted((proj(first[0]), proj(last[0])))
            start, end = lo - END_CAP_M, hi + END_CAP_M
            if bld is not None:
                along = [(vx - ox) * ux + (vy - oy) * uy for vx, vy in bld.exterior.coords
                         if -30 <= (vx - ox) * nx + (vy - oy) * ny <= FACADE_OFFSET_M]
                if along:
                    start = max(start, min(along) - CORNER_OVERSHOOT_M)
                    end = min(end, max(along) + CORNER_OVERSHOOT_M)
            start, end = min(start, lo - MIN_BEYOND_M), max(end, hi + MIN_BEYOND_M)
            band = box(start - 12, 0.5, end + 12, BAND_DEPTH_M)
            band = affinity.affine_transform(band, [ux, nx, uy, ny, ox, oy])
            walk = yard_walks.intersection(band)
            if bld is not None:
                walk = walk.difference(bld.buffer(0.5))
            if walk.is_empty or walk.area < 15:
                stats["facade_without_sidewalk"] += 1
                continue
            offsets = []
            for pt, _ in fac["ents"]:
                q = nearest_points(walk, pt)[0]
                offsets.append((q.x - ox) * nx + (q.y - oy) * ny)
            d = sorted(offsets)[len(offsets) // 2]
            d_cam = min(max(far_edge(walk, ox, oy, ux, uy, nx, ny, [proj(pt) for pt, _ in fac["ents"]], d) + 1, CAMERA_MIN_M), CAMERA_MAX_M)
            n_first = first[1]["properties"].get("№ подъезда")
            n_last = last[1]["properties"].get("№ подъезда")
            first_end = start if proj(first[0]) <= proj(last[0]) else end
            stops = [(start, 1, f"за подъездом {n_first if first_end == start else n_last}"),
                     (end, -1, f"за подъездом {n_last if first_end == start else n_first}")]
            length = end - start
            parts = math.ceil(length / LONG_FACADE_M)
            for k in range(1, parts):
                stops.append((start + length * k / parts, 1, "середина фасада"))
            for a, sign, role in stops:
                q = place(walk, ox, oy, ux, uy, nx, ny, a, d, d_cam)
                if q is None:
                    stats["end_far_from_sidewalk"] += 1
                    continue
                house_points.append({"xy": (q.x, q.y), "az": azimuth(ux * sign, uy * sign), "role": role,
                                     "weight": len(fac["ents"]),
                                     "side": "подъезды " + entrance_range([r["properties"].get("№ подъезда") for _, r in fac["ents"]])})

        # Задняя сторона линейного дома: если вдоль неё тоже идёт дворовый тротуар,
        # сотрудники снимают и его — две точки за углами, взгляд вдоль стены.
        if bld is not None and len(facades) == 1 and house_points:
            ux, uy = facades[0]["u"]
            nx, ny = -facades[0]["n"][0], -facades[0]["n"][1]
            cx, cy = bld.centroid.x, bld.centroid.y
            along = [(vx - cx) * ux + (vy - cy) * uy for vx, vy in bld.exterior.coords]
            depth = max((vx - cx) * nx + (vy - cy) * ny for vx, vy in bld.exterior.coords)
            s0, s1 = min(along), max(along)
            band = affinity.affine_transform(box(s0 - 12, depth + 0.5, s1 + 12, depth + BAND_DEPTH_M), [ux, nx, uy, ny, cx, cy])
            walk = yard_walks.intersection(band).difference(bld.buffer(0.5))
            samples = [s0 + (s1 - s0) * k / 10 for k in range(11)]
            covered = sum(1 for a in samples if not walk.intersection(LineString([
                (cx + ux * a + nx * depth, cy + uy * a + ny * depth),
                (cx + ux * a + nx * (depth + BAND_DEPTH_M), cy + uy * a + ny * (depth + BAND_DEPTH_M))])).is_empty)
            if not walk.is_empty and walk.area >= 15 and covered / len(samples) >= BACK_SIDE_SHARE:
                near = nearest_points(walk, Point(cx + nx * depth, cy + ny * depth))[0]
                d = (near.x - cx) * nx + (near.y - cy) * ny
                d_cam = depth + min(max(far_edge(walk, cx, cy, ux, uy, nx, ny, samples, d) - depth + 1, CAMERA_MIN_M), CAMERA_MAX_M)
                start, end = s0 - CORNER_OVERSHOOT_M, s1 + CORNER_OVERSHOOT_M
                stops = [(start, 1), (end, -1)]
                parts = math.ceil((end - start) / LONG_FACADE_M)
                stops += [(start + (end - start) * k / parts, 1) for k in range(1, parts)]
                for a, sign in stops:
                    q = place(walk, cx, cy, ux, uy, nx, ny, a, d, d_cam)
                    if q is None:
                        continue
                    stats["back_side"] += 1
                    house_points.append({"xy": (q.x, q.y), "az": azimuth(ux * sign, uy * sign), "role": "задняя сторона дома",
                                         "weight": 0, "side": "без подъездов"})

        # Тротуар кругом дома: добавляем остальные углы описанного прямоугольника.
        samples = []
        if bld is not None:
            outer = bld.buffer(6).exterior
            samples = [outer.interpolate(s) for s in range(0, int(outer.length), 5)]
        if samples and house_points and bld is not None:
            covered = sum(1 for s in samples if yard_walks.distance(s) < 5)
            if covered / len(samples) >= RING_SHARE:
                rect = list(bld.minimum_rotated_rectangle.exterior.coords)[:4]
                cx, cy = bld.centroid.x, bld.centroid.y
                for i, (vx, vy) in enumerate(rect):
                    if any(math.dist(hp["xy"], (vx, vy)) < 20 for hp in house_points):
                        continue
                    dx, dy = vx - cx, vy - cy
                    k = math.hypot(dx, dy) or 1
                    home = Point(vx + dx / k * 6, vy + dy / k * 6)
                    q = camera(Point(vx + dx / k * (CAMERA_MIN_M + 2), vy + dy / k * (CAMERA_MIN_M + 2)), home, yard_walks)
                    if q is None:
                        q = nearest_points(yard_walks, home)[0]
                        if q.distance(home) > SNAP_MAX_M:
                            continue
                    nxt = rect[(i + 1) % 4]
                    house_points.append({"xy": (q.x, q.y), "az": azimuth(nxt[0] - vx, nxt[1] - vy),
                                         "role": "угол (тротуар вокруг дома)", "side": "круговой тротуар"})

        for hp in house_points:
            pt = Point(hp["xy"])
            if not yards.contains(pt) or not boundary_m.contains(pt):
                stats["outside_yards"] += 1
                continue
            for other in points:
                if math.dist(other["xy"], hp["xy"]) < MERGE_M:
                    # Направление кадра — от фасада, где больше подъездов.
                    if hp.get("weight", 0) > other.get("weight", 0):
                        other["also"].append(f"{other['address']} ({other['side']})")
                        other.update(az=hp["az"], side=hp["side"], role=hp["role"], weight=hp["weight"],
                                     address=address, unom=unom)
                    else:
                        other["also"].append(f"{address} ({hp['side']})")
                    stats["merged"] += 1
                    break
            else:
                points.append({**hp, "address": address, "unom": unom, "also": []})
        stats["houses_with_points"] += bool(house_points)

    features = []
    points.sort(key=lambda p: (-p["xy"][1], p["xy"][0]))
    kept = []
    if staff:
        # Правки префектуры: её точки остаются как есть, новые рядом с ними
        # и на месте удалённых не ставятся.
        old = {f["properties"]["point_no"]: f for f in load(layers / "sidewalk_shoot.geojson")["features"]}
        live = {no: (L.xy(lng, lat), heading) for no, (lng, lat, heading, flags) in staff.items() if "D" not in flags}
        turn = lambda a, b: min(abs(a - b) % 360, 360 - abs(a - b) % 360)
        gone = [L.xy(lng, lat) for lng, lat, _, flags in staff.values() if "D" in flags]
        before = len(points)
        points = [p for p in points
                  if all(math.dist(p["xy"], xy) >= (STAFF_KEEP_M if turn(p["az"], h) <= 60 else STAFF_SAME_M) for xy, h in live.values())
                  and all(math.dist(p["xy"], xy) >= STAFF_DELETED_M for xy in gone)]
        stats["skipped_near_staff_points"] = before - len(points)
        for no, (lng, lat, heading, flags) in sorted(staff.items()):
            if "D" in flags:
                continue
            base = old.get(no, {}).get("properties") or {}
            nearest = min(points, key=lambda p: math.dist(p["xy"], live[no][0]), default=None)
            kept.append({"type": "Feature", "properties": {
                "point_no": no, "district": district,
                "address": base.get("address") or (nearest["address"] if nearest else district),
                "unom": base.get("unom", nearest["unom"] if nearest else ""),
                "role": base.get("role") or "добавлена префектурой", "side": base.get("side", ""),
                "azimuth": heading, "status": "черновик", "prefecture_edit": True,
            }, "geometry": {"type": "Point", "coordinates": [lng, lat]}})
    for i, p in enumerate(points, first_no):
        props = {
            "point_no": f"Т{DISTRICT_NOS[slug]}.{i:03d}",
            "district": district,
            "address": p["address"],
            "unom": p["unom"],
            "role": p["role"],
            "side": p["side"],
            "azimuth": p["az"],
            "status": "черновик",
        }
        if p["also"]:
            props["also_covers"] = "; ".join(p["also"])
        features.append({"type": "Feature", "properties": props,
                         "geometry": {"type": "Point", "coordinates": list(L.lonlat(*p["xy"]))}})
    features = sorted(features + kept, key=lambda f: int(f["properties"]["point_no"].split(".")[1]))
    out = layers / "sidewalk_shoot.geojson"
    out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"{district}: {len(features)} точек (правки префектуры: {len(kept)}) → {out.relative_to(ROOT)}")
    print(dict(stats))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    opts = dict(a[2:].split("=", 1) for a in sys.argv[1:] if a.startswith("--") and "=" in a)
    for s in args or list(SLUGS):
        staff = read_staff_edits(WORK / opts["staff"], DISTRICT_NOS[s]) if "staff" in opts else None
        build(s, staff=staff, first_no=int(opts.get("first", 1)))
