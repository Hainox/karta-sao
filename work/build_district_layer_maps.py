r"""Фаза 2: нарезка слоёв АСУ по 16 районам и генерация районных страниц атласа.

Вход:  --source  D:\SAO_RECOVERY_20261008\asu-district-layers-20261018  (Фаза 1)
Выход: districts/layers/<slug>/*.geojson + districts/layers/manifest.json
       districts/<slug>.html + districts/index.html  (генерируются из шаблона)

Район определяется попаданием центроида объекта в полигон districts.geojson.
Объекты вне всех 16 полигонов честно уходят в layers/unassigned/.
"""
from __future__ import annotations
import argparse, json, math, pathlib, shutil, sys
DISTRICTS_FILE = pathlib.Path(__file__).resolve().parent.parent / "districts.geojson"
OUT_ROOT = pathlib.Path(__file__).resolve().parent.parent / "districts"
PAGE_TEMPLATE = pathlib.Path(__file__).resolve().parent / "district_page_template.html"

SLUGS = {
    "Аэропорт": "aeroport", "Беговой": "begovoy", "Бескудниковский": "beskudnikovskiy",
    "Войковский": "voykovskiy", "Восточное Дегунино": "vostochnoe-degunino",
    "Головинский": "golovinskiy", "Дмитровский": "dmitrovskiy",
    "Западное Дегунино": "zapadnoe-degunino", "Коптево": "koptevo",
    "Левобережный": "levoberezhnyy", "Молжаниновский": "molzhaninovskiy",
    "Савеловский": "savelovskiy", "Сокол": "sokol", "Тимирязевский": "timiryazevskiy",
    "Ховрино": "hovrino", "Хорошевский": "horoshevskiy",
}

# Номер района внутри округа — по нумерации эталонного набора NextGIS («1.1» = Аэропорт).
DISTRICT_NO = {
    "Аэропорт": "1", "Беговой": "2", "Бескудниковский": "3", "Войковский": "4",
    "Восточное Дегунино": "5", "Головинский": "6", "Дмитровский": "7",
    "Западное Дегунино": "8", "Коптево": "9", "Левобережный": "10",
    "Молжаниновский": "11", "Савеловский": "12", "Сокол": "13",
    "Тимирязевский": "14", "Ховрино": "15", "Хорошевский": "16",
}

# Итоговые слои карты: имя файла -> (русское имя, цвет, включён по умолчанию, описание)
LAYERS = {
    "boundary":  ("Граница района", "#1a3d7c", True, "Официальная граница муниципального округа"),
    "yards":     ("Дворовые территории", "#e8b84a", True, "Дворовые территории (АСУ ОДС, тип 38)"),
    "dp":        ("Детские площадки", "#2e9e52", False, "Детские площадки (тип 27/41)"),
    "sp":        ("Спортивные площадки", "#1f78b4", False, "Спортивные площадки (тип 27/42)"),
    "parking":   ("Автопарковки", "#c2432e", False, "Автопарковки открытого типа (тип 27/1) и парковки на проезжих частях (тип 13)"),
    "paths":     ("Тропинки", "#8a6d3b", False, "Пешеходные и велосипедные дорожки (ДТС, тип 30)"),
    "sidewalks": ("Тротуары", "#b3a2c7", False, "Тротуары (тип 14) и тротуары ДТС (тип 30)"),
    "driveways": ("Проезды", "#7f6a5d", False, "Проезды ДТС (тип 30) и въезды/примыкания (тип 13)"),
    "odh":       ("Объекты ОДХ", "#5f7f95", False, "Объекты дорожного хозяйства (тип 1)"),
}

PROP_KEYS = ["id", "type_id", "sub_type_id", "object_type_name", "object_status_name",
             "parent_type_id", "parent_object_name", "coating_type_name", "total_area"]


def centroid(geom):
    ring = geom["coordinates"][0] if geom["type"] == "Polygon" else geom["coordinates"][0][0]
    xs = [p[0] for p in ring]; ys = [p[1] for p in ring]
    return [sum(xs) / len(xs), sum(ys) / len(ys)]


def pip(point, poly):
    """Ray casting, even-odd; poly = список колец [outer, hole, ...]."""
    x, y = point
    inside = False
    for ring in poly:
        n = len(ring)
        for i in range(n):
            x1, y1 = ring[i]; x2, y2 = ring[(i + 1) % n]
            if (y1 > y) != (y2 > y):
                xint = (x2 - x1) * (y - y1) / (y2 - y1) + x1
                if x < xint:
                    inside = not inside
    return inside


def district_of(point, districts):
    for name, polys in districts.items():
        for poly in polys:
            if pip(point, poly):
                return name
    return None


def load_geojson(path):
    return json.loads(pathlib.Path(path).read_text(encoding="utf-8"))


def build_layers(source_dir, districts):
    """Читает слои Фазы 1 и возвращает {layer_key: {district: [features]}}."""
    src = pathlib.Path(source_dir)
    def features_of(filename):
        return load_geojson(src / filename)["features"]

    out = {k: {} for k in LAYERS}
    out["unassigned_holder"] = {}
    counter = {"unassigned": {}}

    def assign(name, feature, extra=None):
        c = centroid(feature["geometry"])
        dist = district_of(c, districts)
        props = {k: feature["properties"].get(k) for k in PROP_KEYS if feature["properties"].get(k) is not None}
        props["district"] = dist
        if extra:
            props.update(extra)
        feature = {"type": "Feature", "id": feature.get("id"), "properties": props, "geometry": feature["geometry"]}
        if dist is None:
            counter["unassigned"].setdefault(name, 0)
            counter["unassigned"][name] += 1
            out["unassigned_holder"].setdefault(name, []).append(feature)
        else:
            out[name].setdefault(dist, []).append(feature)

    for name in ["yards", "dp", "sp", "odh"]:
        for f in features_of("layer-%s-wgs84.geojson" % name):
            assign(name, f)

    for f in features_of("layer-parking-wgs84.geojson"):
        assign("parking", f, {"source": "planar"})
    for f in features_of("layer-carriageways-wgs84.geojson"):
        otype = f["properties"].get("object_type_name")
        if otype == "Парковка":
            assign("parking", f, {"source": "carriageway_pocket"})
        elif otype in ("Въезд", "Примыкание"):
            assign("driveways", f, {"source": "carriageway"})
        else:
            counter["unassigned"].setdefault("carriageways_other", 0)
            counter["unassigned"]["carriageways_other"] += 1
            out["unassigned_holder"].setdefault("carriageways_other", []).append(f)

    for f in features_of("layer-sidewalks-wgs84.geojson"):
        assign("sidewalks", f, {"source": "sidewalk"})

    for f in features_of("layer-dts-wgs84.geojson"):
        otype = f["properties"].get("object_type_name")
        if otype in ("Пешеходная дорожка", "Велосипедная дорожка"):
            assign("paths", f, {"source": "dts"})
        elif otype == "Тротуар":
            assign("sidewalks", f, {"source": "dts"})
        elif otype == "Проезд":
            assign("driveways", f, {"source": "dts"})
        else:
            counter["unassigned"].setdefault("dts_other", 0)
            counter["unassigned"]["dts_other"] += 1
            out["unassigned_holder"].setdefault("dts_other", []).append(f)

    return out, counter


def write_files(out, counter, districts):
    layers_root = OUT_ROOT / "layers"
    if layers_root.exists():
        shutil.rmtree(layers_root)
    layers_root.mkdir(parents=True)
    manifest = {"layers": {}, "districts": {}, "unassigned": counter.get("unassigned", {})}
    for key, (label, color, enabled, desc) in LAYERS.items():
        manifest["layers"][key] = {"label": label, "color": color, "enabled": enabled, "description": desc}
        for dist in districts:
            feats = out[key].get(dist, [])
            fc = {"type": "FeatureCollection", "name": "%s_%s" % (SLUGS[dist], key),
                  "features": feats}
            (layers_root / SLUGS[dist] / ("%s.geojson" % key)).parent.mkdir(parents=True, exist_ok=True)
            (layers_root / SLUGS[dist] / ("%s.geojson" % key)).write_text(
                json.dumps(fc, ensure_ascii=False), encoding="utf-8")
            manifest["districts"].setdefault(dist, {})[key] = len(feats)
    # границы районов — по одной штуке на страницу
    for dist, polys in districts.items():
        feature = {"type": "Feature", "properties": {"district": dist},
                   "geometry": {"type": "MultiPolygon", "coordinates": polys}
                   if len(polys) > 1 else {"type": "Polygon", "coordinates": polys[0]}}
        (layers_root / SLUGS[dist] / "boundary.geojson").write_text(
            json.dumps({"type": "FeatureCollection", "features": [feature]}, ensure_ascii=False),
            encoding="utf-8")
        manifest["districts"][dist]["boundary"] = 1
    # не приписанные к району — отдельно, чтобы ничего не терялось молча
    una = out.pop("unassigned_holder", {})
    for key, feats in una.items():
        (layers_root / "unassigned" / ("%s.geojson" % key)).parent.mkdir(parents=True, exist_ok=True)
        (layers_root / "unassigned" / ("%s.geojson" % key)).write_text(
            json.dumps({"type": "FeatureCollection", "features": feats}, ensure_ascii=False), encoding="utf-8")
    manifest["totals"] = {k: (16 if k == "boundary" else sum(len(feats) for feats in out[k].values()))
                          for k in LAYERS}
    (layers_root / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    return manifest


def write_pages(districts):
    template = PAGE_TEMPLATE.read_text(encoding="utf-8")
    names = list(districts)
    for n in names:
        # Подсвечиваем район текущей страницы, а не первый в списке.
        links = "".join('<a class="dist-link%s" href="%s.html">%s</a>' % (" active" if other == n else "", SLUGS[other], other)
                        for other in names)
        html = (template
                .replace("{{DISTRICT}}", n)
                .replace("{{SLUG}}", SLUGS[n])
                .replace("{{DISTRICT_NO}}", DISTRICT_NO[n])
                .replace("{{DISTRICT_LINKS}}", links))
        (OUT_ROOT / ("%s.html" % SLUGS[n])).write_text(html, encoding="utf-8")
    index = """<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Карты районов САО — городской атлас</title>
<link rel="icon" href="../favicon.ico" sizes="any">
<style>
:root{--ink:#102636;--muted:#63747d;--line:#d7e0e2;--paper:#f7f5ef;--canvas:#dfe8e8;--accent:#0d827c;}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font-family:"Century Gothic",Inter,Arial,sans-serif}
.topbar{display:flex;align-items:center;gap:12px;min-height:60px;padding:10px 22px;background:var(--paper);border-bottom:1px solid var(--line)}
.topbar a{color:var(--accent);font-weight:800;text-decoration:none}
.catalog{width:min(100% - 32px,1040px);margin:26px auto;padding:26px;background:#fff;border:1px solid var(--line);border-radius:18px}
h1{margin:6px 0 4px;font-size:30px}.intro{color:var(--muted);font-size:16px;line-height:1.6;margin:0 0 20px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
@media(max-width:900px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
.card{display:block;padding:16px 14px;border:1px solid var(--line);border-radius:12px;background:#fff;color:inherit;text-decoration:none}
.card:hover{border-color:var(--accent);box-shadow:0 8px 20px rgba(16,38,54,.1)}
.card b{font-size:16px}.card span{display:block;margin-top:6px;color:var(--muted);font-size:13px}
</style></head><body>
<div class="topbar"><a href="../hub/">← Каталог карт</a><span style="color:var(--muted)">Карты районов САО · 16 муниципальных округов</span></div>
<main class="catalog">
<p style="color:var(--accent);font-size:11px;font-weight:800;letter-spacing:.09em;text-transform:uppercase;margin:0">Районные карты</p>
<h1>Карты районов САО</h1>
<p class="intro">На каждой карте — граница муниципального округа, дворовые территории и слои благоустройства по данным АСУ ОДС: автопарковки, тропинки, тротуары, проезды, детские и спортивные площадки.</p>
<div class="grid">
{{CARDS}}
</div></main></body></html>
"""
    cards = "".join('<a class="card" href="%s.html"><b>%s</b><span>Граница, дворы и слои благоустройства</span></a>' % (SLUGS[n], n) for n in names)
    (OUT_ROOT / "index.html").write_text(index.replace("{{CARDS}}", cards), encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="каталог Фазы 1 с layer-*-wgs84.geojson")
    args = ap.parse_args()
    districts = {}
    for f in load_geojson(DISTRICTS_FILE)["features"]:
        name = f["properties"]["district"]
        geom = f["geometry"]
        polys = geom["coordinates"] if geom["type"] == "MultiPolygon" else [geom["coordinates"]]
        districts[name] = polys
    if set(districts) != set(SLUGS):
        print("District mismatch:", set(districts) ^ set(SLUGS), file=sys.stderr)
        sys.exit(1)
    out, counter = build_layers(args.source, districts)
    manifest = write_files(out, counter, districts)
    write_pages(districts)
    print(json.dumps({"districts": len(districts), "totals": manifest["totals"],
                      "unassigned": manifest["unassigned"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
