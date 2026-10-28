"""Слой входных групп (подъездов МКД) на картах районов — ориентир для точек тротуаров."""
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
LAYERS = ROOT / "districts" / "layers"
SLUGS = ["aeroport", "begovoy", "beskudnikovskiy", "voykovskiy", "vostochnoe-degunino", "golovinskiy",
         "dmitrovskiy", "zapadnoe-degunino", "koptevo", "levoberezhnyy", "molzhaninovskiy", "savelovskiy",
         "sokol", "timiryazevskiy", "hovrino", "horoshevskiy"]

shapely = pytest.importorskip("shapely")
from shapely.geometry import Point, shape  # noqa: E402


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_all_registry_entrances_sit_in_their_district():
    districts = {f["properties"]["district"]: shape(f["geometry"]).buffer(0.003)
                 for f in load(ROOT / "districts.geojson")["features"]}
    total = 0
    seen = set()
    for slug in SLUGS:
        for f in load(LAYERS / slug / "entrances.geojson")["features"]:
            p = f["properties"]
            assert districts[p["district"]].contains(Point(f["geometry"]["coordinates"])), (slug, p["address"], p["entrance"])
            key = (p["unom"], p["entrance"])
            assert key not in seen, key
            seen.add(key)
            assert p["address"] and isinstance(p["entrance"], int)
            total += 1
    # Тот же реестр, что object-maps/data/entrances.json.
    assert total == len(load(ROOT / "object-maps" / "data" / "entrances.json")["records"]) == 10035


def test_entrance_layer_is_prefecture_only_on_every_page():
    template = (ROOT / "work" / "district_page_template.html").read_text(encoding="utf-8")
    for markup in [template] + [(ROOT / "districts" / f"{slug}.html").read_text(encoding="utf-8") for slug in SLUGS]:
        assert '<div id="entranceRefLayer" hidden></div>' in markup
        assert 'src="entrance-ref-layer.js' in markup
        assert "state.entranceLayer.setVisible(isPrefecture());" in markup
