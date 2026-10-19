"""Структурные тесты районных карт: manifest, слои, страницы.

Данные слоёв генерируются work/build_district_layer_maps.py; здесь проверяется
согласованность: страница есть у каждого района, у страницы есть все слои,
граница совпадает с districts.geojson, объекты приписаны своему району.
"""
import json
import math
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DISTRICTS_LAYERS = ROOT / "districts" / "layers"
DISTRICTS_PAGES = ROOT / "districts"
SLUGS = {
    "Аэропорт": "aeroport", "Беговой": "begovoy", "Бескудниковский": "beskudnikovskiy",
    "Войковский": "voykovskiy", "Восточное Дегунино": "vostochnoe-degunino",
    "Головинский": "golovinskiy", "Дмитровский": "dmitrovskiy",
    "Западное Дегунино": "zapadnoe-degunino", "Коптево": "koptevo",
    "Левобережный": "levoberezhnyy", "Молжаниновский": "molzhaninovskiy",
    "Савеловский": "savelovskiy", "Сокол": "sokol", "Тимирязевский": "timiryazevskiy",
    "Ховрино": "hovrino", "Хорошевский": "horoshevskiy",
}
LAYER_KEYS = ["boundary", "yards", "dp", "sp", "parking", "paths", "sidewalks", "driveways", "odh"]


def load_json(path):
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def manifest():
    path = DISTRICTS_LAYERS / "manifest.json"
    assert path.exists(), "districts/layers/manifest.json не сгенерирован"
    return load_json(path)


def test_manifest_covers_all_districts_and_layers():
    man = manifest()
    assert set(man["districts"]) == set(SLUGS), "в манифесте должны быть все 16 районов"
    for district in SLUGS:
        assert set(man["districts"][district]) == set(LAYER_KEYS), \
            f"у района {district} не хватает слоёв"
    for key in LAYER_KEYS:
        assert key in man["layers"], f"в манифесте нет описания слоя {key}"
        assert man["layers"][key]["label"], f"у слоя {key} нет подписи"


def test_totals_match_per_district_counts():
    man = manifest()
    for key in LAYER_KEYS:
        per = sum(man["districts"][d][key] for d in SLUGS)
        assert man["totals"][key] == per, f"totals.{key} расходится с суммой по районам"


def test_every_district_has_page_and_layer_files():
    for district, slug in SLUGS.items():
        assert (DISTRICTS_PAGES / f"{slug}.html").exists(), f"нет страницы {slug}.html"
        for key in LAYER_KEYS:
            assert (DISTRICTS_LAYERS / slug / f"{key}.geojson").exists(), \
                f"нет слоя layers/{slug}/{key}.geojson"


def test_district_index_lists_all_pages():
    html = (DISTRICTS_PAGES / "index.html").read_text(encoding="utf-8")
    for slug in SLUGS.values():
        assert f'href="{slug}.html"' in html, f"в districts/index.html нет ссылки на {slug}.html"


def test_pages_have_no_template_leftovers():
    for slug in SLUGS.values():
        html = (DISTRICTS_PAGES / f"{slug}.html").read_text(encoding="utf-8")
        assert "{{" not in html, f"в {slug}.html остался плейсхолдер шаблона"
        assert f"const SLUG = '{slug}'" in html, f"{slug}.html не знает своего slug"
        assert "layers/${SLUG}/" in html, f"{slug}.html не ссылается на свои слои"
        assert "String(feature.id" in html, f"{slug}.html передаёт YMapFeature числовой id"
        assert "strokeOnly) return { stroke:" in html and "fillOpacity: 0" in html, \
            f"{slug}.html оставляет заливку у границы района"


def test_boundary_matches_districts_geojson():
    source = load_json(ROOT / "districts.geojson")
    source_names = [f["properties"]["district"] for f in source["features"]]
    assert set(source_names) == set(SLUGS), "districts.geojson должен содержать те же 16 районов"
    for district, slug in SLUGS.items():
        fc = load_json(DISTRICTS_LAYERS / slug / "boundary.geojson")
        assert len(fc["features"]) == 1, f"у {district} должна быть одна граница"
        props = fc["features"][0]["properties"]
        assert props["district"] == district, f"boundary {slug} подписан не своим районом"


def test_features_carry_district_and_sane_coordinates():
    man = manifest()
    checked = 0
    for district, slug in SLUGS.items():
        for key in LAYER_KEYS:
            if key == "boundary":
                continue
            if man["districts"][district][key] == 0:
                continue
            fc = load_json(DISTRICTS_LAYERS / slug / f"{key}.geojson")
            sample = fc["features"][:3]
            assert sample, f"{slug}/{key} заявлен непустым, но файл пуст"
            for feat in sample:
                props = feat["properties"]
                assert props.get("district") == district, \
                    f"{slug}/{key}: объект приписан не своему району"
                assert feat["geometry"]["type"] in ("Polygon", "MultiPolygon")
                ring = (feat["geometry"]["coordinates"][0]
                        if feat["geometry"]["type"] == "Polygon"
                        else feat["geometry"]["coordinates"][0][0])
                lons = [p[0] for p in ring]
                lats = [p[1] for p in ring]
                assert 37.3 <= min(lons) <= max(lons) <= 37.8, f"{slug}/{key}: долгота вне САО"
                assert 55.65 <= min(lats) <= max(lats) <= 56.0, f"{slug}/{key}: широта вне САО"
                checked += 1
    assert checked > 0, "не нашлось ни одного объекта для проверки"


def test_unassigned_features_stay_out_of_district_files():
    man = manifest()
    unassigned_dir = DISTRICTS_LAYERS / "unassigned"
    if not unassigned_dir.exists():
        return
    for path in unassigned_dir.glob("*.geojson"):
        fc = load_json(path)
        for feat in fc["features"]:
            assert feat["properties"].get("district") is None, \
                "объект из unassigned не должен иметь район"
    for key in LAYER_KEYS:
        if key == "boundary":
            continue
        per = sum(man["districts"][d][key] for d in SLUGS)
        assert per <= man["totals"][key], "сумма по районам не может превышать общий итог"
