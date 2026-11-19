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
