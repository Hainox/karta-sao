"""Собирает печатную форму A3 «Маршруты СММ» (smm/print-a3.html).

Форма самодостаточна: схемы (smm/dt*.svg) и герб САО встраиваются
base64-данными, поэтому файл можно печатать/сохранять в PDF даже без сети.

Источники:
  - smm.geojson            — контуры и факты дворов (АСУ ОДС, тип 38);
  - smm_routes.geojson     — направление движения и выброса по каждому
                             варианту (GPS-треки или схематичные якоря);
  - smm/dt1..dt5.svg       — инженерные схемы маршрутов.

Печать: A3, альбомная, @page{size:A3 landscape;margin:8mm}. На каждый двор —
карточка со схемой, адресом, векторами движения/выброса и статусом.

Запуск: python work/build_smm_print_a3.py
Выход:  smm/print-a3.html (детерминированный — можно сверять в тестах).
"""

import argparse
import base64
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SMM_DIR = ROOT / "smm"
OUT = SMM_DIR / "print-a3.html"
SRC_SMM = ROOT / "smm.geojson"
SRC_ROUTES = ROOT / "smm_routes.geojson"
COA = ROOT / "sao-coa.png"

VARIANTS = ["dt1", "dt2", "dt3", "dt4", "dt5"]

CARDINALS = {
    0: "север", 45: "северо-восток", 90: "восток", 135: "юго-восток",
    180: "юг", 225: "юго-запад", 270: "запад", 315: "северо-запад",
}


def cardinal(bearing):
    if bearing is None:
        return ""
    return CARDINALS.get(round(bearing / 45) * 45 % 360, f"{round(bearing)}°")


def card(code, yard, route, nozzle, svg_b64):
    properties = yard["properties"]
    name = properties["name"]
    addr = properties.get("address", "")
    district = properties.get("district", "")
    section = properties.get("section", "")
    storage = properties.get("storage", "")
    passes_ = properties.get("passes", "")
    status = properties.get("status", "")

    route_bearing = route["properties"].get("bearing")
    route_src = route["properties"].get("source")
    route_status = route["properties"].get("status")
    nozzle_bearing = nozzle["properties"].get("bearing")
    nozzle_src = nozzle["properties"].get("source")
    nozzle_status = nozzle["properties"].get("status")
    nozzle_note = nozzle["properties"].get("note", "")

    route_pill = f'<span class="pill">{route_src.upper()}</span>' if route_src else ""
    nozzle_pill = f'<span class="pill">{nozzle_src.upper()}</span>' if nozzle_src else ""
    route_text = f"{route_bearing}° · {cardinal(route_bearing)}" if route_bearing is not None else "—"
    nozzle_text = f"{nozzle_bearing}° · {cardinal(nozzle_bearing)}" if nozzle_bearing is not None else "уточняется после осмотра"

    return f"""
    <section class="card">
      <div class="card-head">
        <div>
          <h3>{code} · {name}</h3>
          <p class="addr">{addr} <span class="dot">·</span> {district} <span class="dot">·</span> {section}</p>
        </div>
        <span class="vecs">
          <span class="vec" title="Направление движения по маршруту">
            <span class="arrow movement" style="--rot:{route_bearing or 0}deg"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2v12M4 6l4-5 4 5"/></svg></span>
            <span class="vec-body"><b>Движение</b>{route_text} {route_pill}</span>
          </span>
          <span class="vec" title="Направление выброса снега">
            <span class="arrow nozzle" style="--rot:{nozzle_bearing or 0}deg"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 12 13H4z"/></svg></span>
            <span class="vec-body"><b>Выброс</b>{nozzle_text} {nozzle_pill}</span>
          </span>
        </span>
      </div>
      <div class="scheme">
        <img src="data:image/svg+xml;base64,{svg_b64}" alt="Схема маршрута {code}">
      </div>
      <div class="facts">
        <span><b>Складирование:</b> {storage}</span>
        <span><b>Проходы:</b> {passes_}</span>
        <span><b>Статус:</b> {status}</span>
        {f'<span><b>Маршрут:</b> {route_status}</span>' if route_status else ''}
        {f'<span><b>Выброс:</b> {nozzle_status}</span>' if nozzle_status else ''}
        {f'<span class="note-strip">{nozzle_note}</span>' if nozzle_note else ''}
      </div>
    </section>"""


def build(out_path, smm_path, routes_path, smm_dir, coa_path):
    smm = json.loads(Path(smm_path).read_text(encoding="utf-8"))
    by_id = {feature["id"]: feature for feature in smm["features"]}
    routes = json.loads(Path(routes_path).read_text(encoding="utf-8"))
    route_by_variant = {}
    for feature in routes["features"]:
        props = feature["properties"]
        route_by_variant.setdefault(props["variant_id"], {})[props["feature_kind"]] = feature

    retrieved = smm["metadata"].get("retrieved_at", "2026-08-27")

    if coa_path and Path(coa_path).exists():
        coa_b64 = base64.b64encode(Path(coa_path).read_bytes()).decode("ascii")
        coa_tag = f'<img class="coa" src="data:image/png;base64,{coa_b64}" alt="Герб САО">'
    else:
        coa_tag = '<span class="coa-placeholder">САО</span>'

    cards = []
    for variant in VARIANTS:
        yard = by_id.get(f"smm-{variant}")
        if yard is None:
            raise SystemExit(f"В {smm_path} нет smm-{variant}")
        code = f"ДТ-{variant[-1]}"
        route = route_by_variant.get(variant, {}).get("route_direction", {})
        nozzle = route_by_variant.get(variant, {}).get("nozzle_direction", {})
        svg_name = Path(yard["properties"].get("scheme", f"dt{variant[-1]}.svg").split("?")[0]).name
        svg_b64 = base64.b64encode((Path(smm_dir) / svg_name).read_bytes()).decode("ascii")
        cards.append(card(code, yard, route, nozzle, svg_b64))

    html = f"""<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Маршруты СММ — печать A3</title>
<style>
  :root {{ --ink:#102636; --muted:#687982; --line:#d6e0e1; --paper:#f7f5ef; --accent:#0d827c; --red:#c00000; --orange:#ef6c00; }}
  * {{ box-sizing:border-box; }}
  html, body {{ margin:0; background:#dfe8e8; color:var(--ink); font-family:"Century Gothic", Inter, Arial, sans-serif; }}
  .sheet {{ max-width:1180px; margin:0 auto; padding:20px; }}
  header {{ display:flex; align-items:center; gap:14px; min-height:64px; padding:12px 18px; background:var(--paper); border:1px solid var(--line); border-radius:12px; }}
  .coa {{ width:44px; height:44px; object-fit:contain; mix-blend-mode:multiply; }}
  .coa-placeholder {{ display:grid; place-items:center; width:44px; height:44px; border-radius:10px; background:var(--ink); color:#f5c86a; font-weight:800; font-size:11px; }}
  header h1 {{ margin:0; font-size:21px; line-height:1.15; letter-spacing:-.02em; }}
  header small {{ display:block; margin-top:2px; color:var(--muted); font-size:10px; letter-spacing:.08em; text-transform:uppercase; }}
  header .spacer {{ flex:1; }}
  .btn {{ display:inline-flex; align-items:center; gap:6px; min-height:42px; padding:8px 14px; border:1px solid var(--line); border-radius:9px; background:#fff; color:var(--ink); font:700 12px inherit; text-decoration:none; cursor:pointer; }}
  .btn.print {{ border-color:var(--accent); background:var(--accent); color:#fff; }}
  .btn.print:hover {{ background:#086b66; }}
  .btn:hover {{ border-color:var(--accent); color:var(--accent); }}
  .grid {{ display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin-top:16px; }}
  .card {{ display:flex; flex-direction:column; padding:14px; background:#fff; border:1px solid var(--line); border-radius:12px; }}
  .card-head {{ display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:10px; }}
  .card h3 {{ margin:0; font-size:14px; line-height:1.25; }}
  .card .addr {{ margin:4px 0 0; color:var(--muted); font-size:11px; }}
  .card .addr .dot {{ color:#b8c4c6; }}
  .vecs {{ display:grid; gap:6px; flex:0 0 auto; }}
  .vec {{ display:flex; align-items:center; gap:7px; padding:6px 9px; border:1px solid var(--line); border-radius:9px; background:#fbfcfa; }}
  .arrow {{ display:grid; place-items:center; flex:0 0 26px; width:26px; height:26px; border-radius:50%; color:#fff; transform:rotate(var(--rot,0deg)); }}
  .arrow svg {{ width:15px; height:15px; fill:currentColor; stroke:none; }}
  .arrow.movement {{ background:var(--red); }}
  .arrow.nozzle {{ background:var(--orange); }}
  .vec-body {{ font-size:11px; line-height:1.35; }}
  .vec-body b {{ display:block; color:#54636b; font-size:9px; letter-spacing:.08em; text-transform:uppercase; }}
  .pill {{ display:inline-block; margin-left:4px; padding:1px 6px; border-radius:20px; background:#eef2f4; color:#4a5a63; font-size:9px; font-weight:800; }}
  .scheme {{ height:210px; border:1px solid var(--line); border-radius:10px; background:#f7f8fa; overflow:hidden; }}
  .scheme img {{ display:block; width:100%; height:100%; object-fit:contain; }}
  .facts {{ display:grid; gap:3px; margin-top:10px; font-size:10.5px; line-height:1.4; color:#4a5a63; }}
  .facts b {{ color:var(--ink); }}
  .note-strip {{ margin-top:4px; padding:6px 8px; border-left:3px solid var(--orange); background:#fff8ef; border-radius:0 7px 7px 0; color:#7a5a1c; }}
  .legend {{ margin-top:16px; padding:12px 16px; background:#fff; border:1px solid var(--line); border-radius:12px; font-size:11px; color:#4a5a63; line-height:1.5; }}
  .legend h2 {{ margin:0 0 6px; color:var(--ink); font-size:12px; text-transform:uppercase; letter-spacing:.06em; }}
  .legend p {{ margin:4px 0; }}
  @page {{ size:A3 landscape; margin:8mm; }}
  @media print {{
    html, body {{ background:#fff; }}
    .sheet {{ max-width:none; padding:0; }}
    header {{ min-height:0; padding:2mm 0; border:0; border-bottom:1px solid #9da9aa; border-radius:0; margin-bottom:3mm; }}
    .coa {{ width:12mm; height:12mm; }}
    header h1 {{ font-size:16pt; }}
    header small {{ font-size:7pt; }}
    .btn {{ display:none; }}
    .grid {{ gap:4mm; margin-top:0; }}
    .card {{ padding:3mm; border-radius:0; page-break-inside:avoid; }}
    .card-head {{ margin-bottom:2mm; }}
    .card h3 {{ font-size:10.5pt; }}
    .card .addr {{ font-size:8pt; }}
    .vec {{ padding:1.5mm; gap:1.5mm; }}
    .arrow {{ width:6mm; height:6mm; flex-basis:6mm; }}
    .vec-body {{ font-size:7.5pt; }}
    .scheme {{ height:64mm; border-radius:0; }}
    .facts {{ margin-top:2mm; font-size:7.5pt; }}
    .legend {{ margin-top:4mm; padding:2mm 3mm; border-radius:0; font-size:7.5pt; }}
    .legend h2 {{ font-size:9pt; }}
  }}
</style>
</head>
<body>
  <div class="sheet">
    <header>
      {coa_tag}
      <div><h1>Маршруты СММ — печать A3<small>Схемы движения и направление выброса снега · пять эталонных дворов</small></h1></div>
      <div class="spacer"></div>
      <button class="btn print" id="printBtn" type="button">Печать / PDF A3</button>
      <a class="btn" href="../">Городской атлас САО</a>
    </header>
    <main class="grid">
      {''.join(cards)}
    </main>
    <section class="legend">
      <h2>Легенда</h2>
      <p>Толстая красная линия — осевая линия прохода СММ; красная стрелка — направление движения; оранжевая стрелка — направление выброса снега; синие тонкие стрелки — вектор струи в характерных точках, синие точки — расчётные точки приземления; голубая штриховка Н-1…Н-5 — назначенные места складирования; красный пунктирный круг — приствольный круг (1,5 м), светло-зелёный круг — проекция кроны.</p>
      <p>Контуры: АСУ ОДС (тип 38, МСК-77 → WGS84), редакция {retrieved}. Направления: GPS-треки и замеры при наличии, иначе — схематично (утверждаются после натурного осмотра).</p>
    </section>
  </div>
  <script>
    document.getElementById('printBtn').addEventListener('click', () => window.print());
  </script>
</body>
</html>
"""
    Path(out_path).write_text(html, encoding="utf-8")
    print(f"Записана печатная форма: {out_path}")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Сборка печатной формы СММ A3")
    parser.add_argument("--out", default=str(OUT))
    parser.add_argument("--smm-json", default=str(SRC_SMM))
    parser.add_argument("--routes-json", default=str(SRC_ROUTES))
    parser.add_argument("--smm-dir", default=str(SMM_DIR))
    parser.add_argument("--coa", default=str(COA))
    args = parser.parse_args(argv)
    build(args.out, args.smm_json, args.routes_json, args.smm_dir, args.coa)


if __name__ == "__main__":
    main()