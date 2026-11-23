import pytest
from shapely.geometry import box
from geometry import plan, clip_contact


def test_straight_chainage_and_single_short_view():
    _, points, _, _ = plan(box(0, 0, 254, 3))
    assert [p["station"] for p in points] == pytest.approx([0, 100, 200])
    _, points, _, _ = plan(box(0, 0, 28, 3))
    assert len(points) == 1


def test_contact_only_cuts_connected_section():
    path = box(0, 0, 100, 3)
    excluded, uncertain = clip_contact(path, box(40, 3, 66, 20))
    assert not uncertain and excluded.area > 65
    assert excluded.area < 100
    assert path.difference(excluded).area > 200
    assert clip_contact(path, box(100, 3, 108, 20))[1]

def test_one_station_per_position_and_known_wall():
    from shapely.geometry import Point
    bent = box(0, 0, 130, 3).union(box(110, 0, 113, 38))
    wall = box(55, 4, 109, 25)
    _, points, counts, _ = plan(bent, wall)
    assert len(points) == len({p['xy'] for p in points})
    assert all(bent.contains(Point(p['xy'])) for p in points)
    assert 0 < counts['covered'] <= counts['samples']


def test_shared_edges_and_overlap_with_playground():
    path = box(0, 0, 90, 4)
    cut, ambiguous = clip_contact(path, box(20, 3, 40, 15))
    assert not ambiguous
    assert cut.covers(box(22, 0.1, 38, 3.9))
    assert path.difference(cut).covers(box(45, 0.1, 80, 3.9))

def test_sports_ring_and_short_access_are_fully_excluded_but_through_road_survives():
    from geometry import sports_cut
    site = box(0, 0, 20, 20)
    ring = site.buffer(2, join_style='mitre').difference(site)
    access = box(20, 7, 27, 9)
    path = ring.union(access)
    cut, _, _ = sports_cut(path, site)
    assert cut.equals(path)
    road = path.union(box(-50, -2, 60, 0))
    cut, _, _ = sports_cut(road, site)
    assert cut.covers(ring)
    assert cut.disjoint(box(-45, -1.9, -10, -0.1))


def test_short_island_requires_external_host_even_without_neighbour():
    from outer_views import choose_hosts
    from shapely.geometry import LineString
    rows = [
        dict(rid='stub', district='a', lines=[LineString([(0,0),(12,0)])], poly=box(-1,-1,13,1), rule='short'),
        dict(rid='main', district='a', lines=[LineString([(0,14),(140,14)])], poly=box(-1,13,141,15), rule='long')
    ]
    assert choose_hosts(rows) == {'main'}
    assert choose_hosts(rows[:1]) == set()


def test_two_neighbouring_stubs_can_use_a_shorter_outer_collector():
    from shapely.geometry import LineString
    from outer_views import choose_hosts
    def row(rid,x,y,length):
        return dict(rid=rid,district='a',lines=[LineString([(x,y),(x+length,y)])],
                    poly=box(x,y-1,x+length,y+1),rule='short')
    assert choose_hosts([row('west',4,8,7),row('east',12,9,5),row('outer',0,0,64)]) == {'outer'}


def test_solo_short_and_ordinary_neighbour_stay_in_their_own_assignment():
    from shapely.geometry import LineString
    from outer_views import choose_hosts, inner_routes
    def row(rid,x,y,length):
        return dict(rid=rid,district='a',lines=[LineString([(x,y),(x+length,y)])],
                    poly=box(x,y-1,x+length,y+1),rule='short')
    solo=row('solo',0,0,12)
    assert inner_routes([solo],set())==set()
    neighbor=row('collector',0,13,120)
    assert inner_routes([solo,neighbor],{'collector'})==set()
    rows=[solo,row('second',18,4,8),neighbor]
    assert inner_routes(rows,choose_hosts(rows))=={'solo','second'}
