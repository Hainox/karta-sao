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
DISTRICT_NOS = {
    "aeroport": "1", "begovoy": "2", "beskudnikovskiy": "3", "voykovskiy": "4",
    "vostochnoe-degunino": "5", "golovinskiy": "6", "dmitrovskiy": "7",
    "zapadnoe-degunino": "8", "koptevo": "9", "levoberezhnyy": "10",
    "molzhaninovskiy": "11", "savelovskiy": "12", "sokol": "13",
    "timiryazevskiy": "14", "hovrino": "15", "horoshevskiy": "16",
}


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
        assert "feature._ymapFeature = child" in html and "state.map.removeChild(child)" in html, \
            f"{slug}.html не умеет снимать выключенные слои"
        # Точки съёмки: кружки в просмотре, сохранённые направления — в режиме разметки
        assert "Точки съёмки" in html, f"{slug}.html нет инструмента точек съёмки"
        assert 'id="shootLayerToggle"' in html, \
            f"{slug}.html точки съёмки не вынесены в отдельный слой"
        assert "ПРОБНЫЙ ИМПОРТ" not in html, \
            f"{slug}.html осталась пометка пробного импорта на слое точек съёмки"
        assert "if (!pointVisible(point)) return;" in html and "state.shootLayerOn" in html, \
            f"{slug}.html рисует точки съёмки при выключенном слое"
        assert 'id="gpkgLayerToggle"' not in html, \
            f"{slug}.html остался отдельный слой GPKG"
        assert re.findall(r'class="dist-link active" href="([^"]+)"', html) == [f"{slug}.html"], \
            f"{slug}.html в списке районов подсвечен не свой район"
        assert "outline: { color: '#9a6400', width: 2.4 }" in html, \
            f"{slug}.html границы дворов не выделены тёмной обводкой"
        enabled = re.findall(r"\{ key: '(\w+)',[^}]*enabled: true", html)
        assert enabled == ['boundary', 'yards'], \
            f"{slug}.html по умолчанию включены {enabled}: включены должны быть только граница и дворы"
        assert "YMapListener({ layer: 'any', onClick" in html, \
            f"{slug}.html не ловит клики по карте для точек съёмки"
        assert "new YMapMarker({ coordinates" in html, \
            f"{slug}.html ставит точки не на географических координатах"
        assert "shoot-dot" in html and ".shoot-arrow{display:block" in html and "--shoot-arrow-scale" in html, \
            f"{slug}.html не показывает направления точек в режиме разметки"
        assert "Math.round(bearing(" in html, \
            f"{slug}.html не считает азимут направления"
        assert f"const DISTRICT_NO = '{DISTRICT_NOS[slug]}'" in html, \
            f"{slug}.html неверный номер района в нумерации точек"
        assert "userRotation" not in html, \
            f"{slug}.html включает вращение карты — азимут направления разошёлся бы с экраном"
        # Общий контур фотослужбы: точки с сервера, вход префектуры
        assert "object-photo-points/public" in html, \
            f"{slug}.html не загружает точки съёмки с сервера"
        assert "/auth/login" in html and "prefecture_admin" in html, \
            f"{slug}.html нет входа учётной записью префектуры"
        assert "sao_district_photo_points" in html, \
            f"{slug}.html работает не с районным набором точек"
        # Фото по точкам (район) и Excel-сводка (префектура)
        assert "report.xlsx" in html and "X-Assignment-Version" in html, \
            f"{slug}.html нет сводки Excel и отправки фото по точкам"
        assert "district_editor" in html, \
            f"{slug}.html не различает учётки районов для отправки фото"
        # Приёмка точек отключена: точки ставит только префектура, кабинета acceptance.html нет
        assert "isDistrictEditor" in html and "review_status" in html, \
            f"{slug}.html не различает учётки районов (isDistrictEditor/review_status)"
        assert 'id="pointAcceptance"' not in html and "acceptance.html" not in html, \
            f"{slug}.html осталась ссылка на отключённый кабинет приёмки точек"
        assert "return isDistrictEditor() && state.shootLayerOn;" in html, \
            f"{slug}.html район не видит свои точки в слое съёмки после входа (включая ожидающие приёмки)"
        assert "&& (point.prefectureArchive || (point.review_status" not in html, \
            f"{slug}.html фотослот ошибочно зависит от старого статуса приёмки точки"
        assert 'id="shootPhotoReport"' in html and "downloadDistrictReport" in html and "&report=" in html, \
            f"{slug}.html нет отдельной сводки Excel по фото"
        # По актуальному заданию на карте остаётся один точечный слой.
        assert 'id="prefectureArchiveRow"' not in html and 'id="gpkgLayerRow"' not in html, \
            f"{slug}.html показывает дополнительные точечные слои"
        assert "button.textContent = 'Загрузить фото'" in html, \
            f"{slug}.html нет явной кнопки загрузки в фотослот"
        # Полное редактирование точки: подпись, координаты, азимут, примечание
        assert 'name="label"' in html and 'name="latitude"' in html and 'name="longitude"' in html, \
            f"{slug}.html не позволяет редактировать подпись и координаты точки"
        assert 'name="heading"' in html and 'name="note"' in html, \
            f"{slug}.html не позволяет редактировать направление и примечание"
        assert "savePointEdits" in html, \
            f"{slug}.html не сохраняет изменения точки"
        assert "Маркеры карты держат ссылки на объекты Яндекс Карт" in html, \
            f"{slug}.html сериализует маркеры карты в localStorage и теряет локальные правки"


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


def test_objects_inside_a_registry_yard_sit_on_that_yards_district_page():
    """Двор из REGISTRY_YARDS и всё внутри него — на карте района двора по реестру АСУ ОДС.

    2026-10-28 двор «Бескудниковский бульв. 10 к.1–5» (Бескудниковский) с тротуарами
    и проездами оказался на карте Восточного Дегунина: граница OSM целиком относит его туда.
    """
    from work.build_district_layer_maps import YardRegistry, centroid

    registry = YardRegistry.load()
    wrong = []
    for name, slug in SLUGS.items():
        for key in LAYER_KEYS:
            if key == "boundary":
                continue
            data = json.loads((DISTRICTS_LAYERS / slug / f"{key}.geojson").read_text(encoding="utf-8"))
            for feat in data["features"]:
                owner = registry.district_at(centroid(feat["geometry"]))
                if owner and owner != name:
                    wrong.append((slug, key, feat["properties"].get("id"), owner))
    assert wrong == []

    yards = json.loads((DISTRICTS_LAYERS / "beskudnikovskiy" / "yards.geojson").read_text(encoding="utf-8"))
    assert 128225312100038 in {f["properties"]["id"] for f in yards["features"]}


def test_both_digitizations_sit_together_under_shooting_points():
    """Въездные группы и площадки ДП/СП — две оцифровки в одном блоке «Точки съёмки».

    Слой площадок стоит сразу за слоем въездных групп, а не среди слоёв АСУ ОДС.
    Шаблон и 16 страниц совпадают, чтобы пересборка не теряла слой площадок.
    """
    template = (ROOT / "work" / "district_page_template.html").read_text(encoding="utf-8")
    for markup in [template] + [(DISTRICTS_PAGES / f"{slug}.html").read_text(encoding="utf-8") for slug in SLUGS.values()]:
        assert '<span class="label">Точки съёмки · въездные группы</span>' in markup
        entrances = markup.index('id="shootLayerRow"')
        playgrounds = markup.index('<div id="playgroundPhotoLayer"></div>')
        assert markup.index('<div id="layerControls"></div>') < markup.index("<b>Точки съёмки</b>") < entrances < playgrounds
        assert playgrounds < markup.index('class="shoot-list-box"')
        assert "playground-photo-layer.js" in markup


def test_shooting_points_hint_counts_only_the_entrance_layer():
    """Подсказка «Точек съёмки: N» считает те же точки, что слой «въездные группы».

    Под учётной записью префектуры список точек включает импортные наборы NextGIS/GPKG;
    в слой они не входят, значит и в счёт не должны.
    """
    for slug in SLUGS.values():
        html = (DISTRICTS_PAGES / f"{slug}.html").read_text(encoding="utf-8")
        assert "Точек съёмки: ${state.points.length}" not in html, slug
        assert html.count("Точек съёмки: ${layerPointCount()") == 4, slug
        assert "$('shootLayerCount').textContent = layerPointCount()" in html, slug


def test_centering_only_in_view_or_hand_mode():
    """Центрирование на объекте не срабатывает в «Разметке» и «Переносе», только в просмотре или с «Рукой».

    Правило одно на все слои: точки съёмки, площадки ДП/СП и тротуары центрируют карту через centerSelection.
    """
    guard = "if ((state.shootMode || state.dragMode) && !state.handMode) return;"
    template = (ROOT / "work" / "district_page_template.html").read_text(encoding="utf-8")
    for markup in [template] + [(DISTRICTS_PAGES / f"{slug}.html").read_text(encoding="utf-8") for slug in SLUGS.values()]:
        body = markup[markup.index("function centerSelection(coordinates) {"):]
        assert guard in body[:body.index("\n  }\n")]
        assert "preparePointPhoto, escapeHtml, centerSelection" in markup
    layer = (DISTRICTS_PAGES / "playground-photo-layer.js").read_text(encoding="utf-8")
    assert "map.update({location:{center" not in layer
    assert "centerSelection(coordinates)" in layer


def test_points_open_in_popover_card():
    """Карточка точки открывается окном у самой точки; площадные объекты остаются в левом меню.

    Окно (districts/point-popover.js) подключено на всех страницах, все три вида точек
    открывают его, а площадные объекты пишут в отдельную карточку #objectCard.
    """
    template = (ROOT / "work" / "district_page_template.html").read_text(encoding="utf-8")
    for markup in [template] + [(DISTRICTS_PAGES / f"{slug}.html").read_text(encoding="utf-8") for slug in SLUGS.values()]:
        assert 'href="point-popover.css' in markup and 'src="point-popover.js' in markup
        assert '<div class="card" id="objectCard"></div>' in markup
        assert "state.popover = window.createPointPopover(" in markup
        assert "state.popover.open({ coordinates: [Number(point.lng), Number(point.lat)], kind: 'entrance'" in markup
        assert "popover: state.popover" in markup
    for layer in ("playground-photo-layer.js", "sidewalk-shoot-layer.js"):
        assert "popover.open(" in (DISTRICTS_PAGES / layer).read_text(encoding="utf-8")


def test_district_pages_use_shared_hud_and_prefecture_summary():
    """Панель карт районов стоит на общей основе атласа, а сводка видна только префектуре.

    Режимы правки — один переключатель с «Просмотром»; «Рука» видна лишь во время правки.
    """
    template = (ROOT / "work" / "district_page_template.html").read_text(encoding="utf-8")
    for markup in [template] + [(DISTRICTS_PAGES / f"{slug}.html").read_text(encoding="utf-8") for slug in SLUGS.values()]:
        assert 'href="../atlas-hud.css' in markup and 'src="../atlas-hud.js' in markup and 'src="../atlas-summary.js' in markup
        assert '<aside class="sidebar hud">' in markup
        assert 'id="viewToggle"' in markup and 'id="modeBar"' in markup
        assert "if (state.summary) state.summary.setVisible(isPrefecture());" in markup
        assert "$('shootLogout').addEventListener('click'" in markup
    for name in ("atlas-hud.css", "atlas-hud.js", "atlas-summary.js"):
        assert (ROOT / name).exists(), name
    css = (ROOT / "atlas-hud.css").read_text(encoding="utf-8")
    assert ".hud-btn[hidden]{display:none}" in css
    assert "prefers-reduced-motion" in css
