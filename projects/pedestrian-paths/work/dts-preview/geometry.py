"""Геометрическая модель ДТС. Координаты входа модулей расчёта задаются в метрах."""
from collections import defaultdict
import heapq
import math

from shapely import constrained_delaunay_triangles, line_merge, union_all
from shapely.geometry import LineString, Point, Polygon
from shapely.prepared import prep

STEP = 100.0
SAMPLE = 10.0
HALF_ANGLE = 35.0


def parts(g, kind):
    if g.is_empty:
        return []
    if g.geom_type == kind:
        return [g]
    if hasattr(g, 'geoms'):
        return [p for child in g.geoms for p in parts(child, kind)]
    return []


def clip_contact(path, site):
    """Areal overlap plus adjacent path width along the observed shared edge."""
    overlap = path.intersection(site)
    cuts = parts(overlap, 'Polygon')
    shared = path.intersection(site.boundary)
    width = 2 * path.area / path.length
    for edge in parts(shared, 'LineString'):
        cuts.append(edge.buffer(width, cap_style='flat'))
    # A point touch carries no evidence about the adjoining length.
    return path.intersection(union_all(cuts)), not overlap.is_empty and not cuts


def middle(edge):
    a, b = edge
    return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)


def axes(poly):
    """Dual graph of the constrained triangulation, inside polygon incl. holes."""
    triangles = list(constrained_delaunay_triangles(poly).geoms)
    edges = []
    counts = defaultdict(int)
    for tri in triangles:
        ring = list(tri.exterior.coords)
        sides = [tuple(sorted((a, b))) for a, b in zip(ring, ring[1:])]
        edges.append(sides)
        for side in sides:
            counts[side] += 1
    graph = defaultdict(dict)
    def join(a, b):
        if a != b:
            graph[a][b] = graph[b][a] = math.dist(a, b)
    for tri, sides in zip(triangles, edges):
        inner = [middle(e) for e in sides if counts[e] == 2]
        if len(inner) == 2:
            join(*inner)
        elif len(inner) == 3:
            for m in inner:
                join(m, tri.centroid.coords[0])
        else:
            # At the end of a strip the shorter boundary side spans its width.
            outer = sorted((e for e in sides if counts[e] == 1), key=lambda e: math.dist(*e))
            a, b = inner[0] if inner else middle(outer[1]), middle(outer[0])
            # Keep cameras just inside the end, including triangular fragments.
            t = min(0.25, 0.25 / max(math.dist(a, b), 0.001))
            join(a, tuple(x + t * (y-x) for x,y in zip(b,a)))
    if not graph:
        return []
    # Prune short side shoots from noisy outlines, retaining the main axis.
    width = 2 * poly.area / poly.length
    for leaf in list(graph):
        if len(graph.get(leaf, {})) != 1:
            continue
        previous, current, branch, length = None, leaf, [], 0
        while True:
            ahead = [v for v in graph[current] if v != previous]
            if len(ahead) != 1:
                break
            nxt = ahead[0]
            length += graph[current][nxt]
            branch.append(current)
            previous, current = current, nxt
        if len(graph[current]) >= 3 and length < width:
            del graph[current][previous]
            for v in branch:
                del graph[v]

    def farthest(start):
        costs, parent, queue = {start:0}, {}, [(0,start)]
        while queue:
            d, u = heapq.heappop(queue)
            if d != costs[u]:
                continue
            for v,w in graph[u].items():
                if d+w < costs.get(v, math.inf):
                    costs[v], parent[v] = d+w, u
                    heapq.heappush(queue, (d+w, v))
        return max(costs, key=costs.get), parent
    start, _ = farthest(min(graph))
    end, parent = farthest(start)
    main = [end]
    while main[-1] != start:
        main.append(parent[main[-1]])
    used = {tuple(sorted((a,b))) for a,b in zip(main,main[1:])}
    others = [LineString([a,b]) for a, neighbors in graph.items() for b in neighbors
              if a < b and (a,b) not in used]
    return [LineString(main)] + parts(line_merge(union_all(others)), 'LineString')


def heading(a,b):
    return math.degrees(math.atan2(b[0]-a[0], b[1]-a[1])) % 360


def plan(poly, obstacles=None, original_views=()):
    lines = axes(poly)
    if not lines:
        return [], [], {}, 'short'
    main = lines[0]
    rect = poly.minimum_rotated_rectangle
    ring = list(rect.exterior.coords)
    lengths = [math.dist(a,b) for a,b in zip(ring,ring[1:])]
    aspect = max(lengths)/max(min(lengths), 0.000001)
    secondary = sum(l.length for l in lines[1:])
    branched = secondary > max(8, main.length * 0.15)
    compact = main.length <= STEP and aspect <= 3 and (poly.area/rect.area > 0.65 or branched)
    rule = 'compact' if compact else 'branched' if branched else 'long' if main.length > STEP else 'short'
    targets = []
    for line in lines:
        count = max(1, math.ceil(line.length / SAMPLE))
        targets.extend(line.interpolate(i / count, normalized=True).coords[0] for i in range(count+1))
    if compact:
        # Interior observations also represent the breadth of a paved area.
        targets.append(poly.representative_point().coords[0])
    targets = list(dict.fromkeys(targets))
    blockers = prep(obstacles) if obstacles is not None and not obstacles.is_empty else None
    def visible(a,b):
        return math.dist(a,b) <= STEP + 0.01 and (a == b or blockers is None or not blockers.intersects(LineString([a,b])))

    chosen, seen = [], set()
    def coverage(origin, angle, candidates):
        return {i for i in candidates if math.dist(origin, targets[i]) < 0.01 or
                (abs((heading(origin,targets[i])-angle+180)%360-180) <= HALF_ANGLE + 1e-7
                 and visible(origin,targets[i]))}

    def add(origin, aim, station=None):
        angle = heading(origin,aim)
        observed = coverage(origin,angle,range(len(targets)))
        chosen.append(dict(xy=origin, aim=aim, station=station, covered=observed))
        seen.update(observed)

    if rule == 'long':
        # Preserve exactly 100 m along the reconstructed centreline until a
        # curve prevents seeing the next section from this end.
        station = 0
        while station < main.length:
            origin = main.interpolate(station).coords[0]
            end = min(main.length,station+STEP)
            stops = max(1, math.ceil((end-station)/SAMPLE))
            aim_s = station
            for n in range(1,stops+1):
                s = station + (end-station)*n/stops
                candidate = main.interpolate(s).coords[0]
                if not visible(origin,candidate):
                    break
                aim_s = s
            if aim_s == station:
                # The next sampled chord leaves this bend. Let the set cover
                # below handle both sides from positions on the actual axis.
                break
            add(origin,main.interpolate(aim_s).coords[0],station)
            station = aim_s
    # Choose an inward view covering the most uncovered samples. Endpoints and
    # perimeter positions go first on ties. Stop if all samples are accounted for.
    missing = set(range(len(targets))) - seen
    if missing:
        perimeter = []
        if rule in ('compact','branched'):
            for n in range(12):
                boundary = poly.exterior.interpolate(n/12, normalized=True)
                # Position 10 cm inside the mapped surface if possible.
                inside = poly.buffer(-0.10)
                if not inside.is_empty:
                    from shapely.ops import nearest_points
                    perimeter.append(nearest_points(inside, boundary)[0].coords[0])
        prior = dict(original_views)
        origins = list(dict.fromkeys(perimeter + list(prior) + targets))
        # Cache rays once per position and score all angular windows.
        candidates = []
        occupied = {view['xy'] for view in chosen}
        for origin in origins:
            if origin in occupied or not poly.contains(Point(origin)):
                continue
            # Spatial filter before expensive intersection checks.
            rays = [(i,heading(origin,targets[i])) for i in sorted(missing)
                    if origin != targets[i] and visible(origin,targets[i])]
            if not rays:
                continue
            aimed = sorted({a for _,a in rays})
            window_edges = sorted({(a+HALF_ANGLE)%360 for _,a in rays})
            for angle in dict.fromkeys(prior.get(origin,[]) + aimed + window_edges):
                hits = frozenset(i for i,a in rays if abs((a-angle+180)%360-180) <= HALF_ANGLE + 1e-8)
                own = {i for i in missing if targets[i] == origin}
                hits = hits | own
                candidates.append((origin,angle,hits))
        while missing and candidates:
            origin, angle, hits = max(candidates,key=lambda item:len(missing & item[2]))
            if not hits & missing:
                break
            r = math.radians(angle)
            aim = origin[0]+math.sin(r),origin[1]+math.cos(r)
            chosen.append(dict(xy=origin, aim=aim, station=None, covered=hits))
            seen.update(hits)
            missing -= hits
            candidates = [c for c in candidates if c[0] != origin]
    # Drop a station only if every control sample still has another view.
    # Keep longitudinal chainage stations for the maximum-gap guarantee.
    from collections import Counter
    for c in chosen:
        c['covered'] = coverage(c['xy'],heading(c['xy'],c['aim']),range(len(targets)))
    frequency = Counter(i for c in chosen for i in c['covered'])
    for j in reversed(range(len(chosen))):
        c = chosen[j]
        if c['station'] is None and all(frequency[i] > 1 for i in c['covered']):
            frequency.subtract(c['covered'])
            del chosen[j]
    for c in chosen:
        c['unique_samples'] = sum(frequency[i] == 1 for i in c['covered'])
        c['perimeter'] = c['xy'] in perimeter if rule in ('compact','branched') else False
    old_seen = set()
    for origin,angles in original_views:
        for a in angles:
            old_seen.update(coverage(origin,a,range(len(targets))))
    return lines, chosen, dict(samples=len(targets), covered=sum(v>0 for v in frequency.values()), old_covered=len(old_seen)), rule
