from pathlib import Path


page = (Path(__file__).resolve().parents[1] / "print-1000x1400.html").read_text(encoding="utf-8")
index = (Path(__file__).resolve().parents[1] / "index.html").read_text(encoding="utf-8")

required_fragments = {
    "custom paper size": "@page { size: 1000mm 1400mm; margin: 0; }",
    "sheet size": "width: 1000mm; height: 1400mm",
    "lower-left legend coordinates": "left: 26.19mm; bottom: 26.95mm; width: 254.97mm; height: 388.07mm",
    "print-safe legend fill": "background: #fff",
    "queue I color": "queue1: '#FF0000'",
    "queue II color": "queue2: '#0000FF'",
    "queue III color": "queue3: '#00B050'",
    "SAO queue counts": "I очередь — 98 позиций",
    "SAO queue II count": "II очередь — 318 позиций",
    "SAO queue III count": "III очередь — 272 позиции",
    "print page title": "СЕВЕРНЫЙ АДМИНИСТРАТИВНЫЙ ОКРУГ",
    "high-resolution raster map layer": 'id="basemap" width="3600" height="5040"',
    "vector route layer": 'id="features"',
    "route projection": "function project(coordinate, view, width = FEATURE_WIDTH, height = FEATURE_HEIGHT)",
    "high-detail tiles": "const TILE_ZOOM = 13;",
    "compact route strokes": "width: 2.05",
    "point clustering": "function drawPointLayer(features, item, view)",
    "zoom controls": 'id="zoom-in"',
    "fit-to-area control": 'id="zoom-reset"',
    "basemap selector": 'id="basemap-style"',
    "CARTO tile provider": "basemaps.cartocdn.com",
    "CARTO Positron": "light_all",
    "CARTO Voyager": "rastertiles/voyager",
    "CARTO attribution": "© OpenStreetMap contributors © CARTO",
    "readable objects heading": "<h3>Объекты и места</h3>",
    "readable legend text": "font-size: 7.35mm",
    "readable legend source note": "font-size: 5.75mm",
}

missing = [description for description, fragment in required_fragments.items() if fragment not in page]
if missing:
    raise SystemExit("Missing reference-print requirements: " + ", ".join(missing))

if "print-1000x1400.html" not in index or "Печать 1000 × 1400 мм" not in index:
    raise SystemExit("The interactive page does not link to the reference print layout.")

print("Reference print static checks passed.")
