import json
from pathlib import Path


page = (Path(__file__).resolve().parents[1] / "print-1000x1400.html").read_text(encoding="utf-8")
index = (Path(__file__).resolve().parents[1] / "index.html").read_text(encoding="utf-8")
boundary_path = Path(__file__).resolve().parents[1] / "layers" / "sao_boundary_wgs84.geojson"
boundary = json.loads(boundary_path.read_text(encoding="utf-8"))

required_fragments = {
    "custom paper size": "@page { size: 1000mm 1400mm; margin: 0; }",
    "sheet size": "width: 1000mm; height: 1400mm",
    "lower-left legend coordinates": "left: 26.19mm; bottom: 26.95mm; width: 254.97mm; height: 388.07mm",
    "print-safe legend fill": "background: #fff",
    "queue I color": "--line-color:#d32f2f",
    "queue II color": "--line-color:#1565c0",
    "queue III color": "--line-color:#2e7d32",
    "SAO queue counts": "I очередь — 98 позиций",
    "SAO queue II count": "II очередь — 318 позиций",
    "SAO queue III count": "III очередь — 272 позиции",
    "print page title": "СЕВЕРНЫЙ АДМИНИСТРАТИВНЫЙ ОКРУГ",
    "high-resolution raster map layer": 'id="basemap" width="3600" height="5040"',
    "vector route layer": 'id="features"',
    "route projection": "function project(coordinate, view, width = targetSvg.viewBox.baseVal.width || FEATURE_WIDTH",
    "high-detail tiles": "const TILE_ZOOM = 13;",
    "interactive route strokes": "width: 4, opacity: .92",
    "interactive boundary stroke": "width: 4.5, opacity: 1, dashArray: '9 6'",
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
    "drag-to-pan interaction": "canvas.addEventListener('pointerdown'",
    "wheel zoom interaction": "canvas.addEventListener('wheel'",
    "map gesture hint": "Левая кнопка — перемещение · колесо — масштаб",
}

missing = [description for description, fragment in required_fragments.items() if fragment not in page]
if missing:
    raise SystemExit("Missing reference-print requirements: " + ", ".join(missing))

if "print-1000x1400.html" not in index or "Печать / PDF" not in index:
    raise SystemExit("The interactive page does not link to the reference print layout.")

main_boundary = [feature for feature in boundary["features"] if feature.get("properties", {}).get("feature_kind") == "boundary_sao"]
if len(main_boundary) != 1 or main_boundary[0].get("geometry", {}).get("type") != "MultiPolygon":
    raise SystemExit("The SAO boundary must have one MultiPolygon source geometry.")

if "feature.properties?.feature_kind === 'boundary_sao'" not in page:
    raise SystemExit("The print layout renders an extra duplicate SAO boundary feature.")

for obsolete_fragment in ("print-inset", "inset-features", "boundarySections(", "insetBoundary", "insetView"):
    if obsolete_fragment in page:
        raise SystemExit(f"The print layout must keep the full SAO boundary on one map, without an inset: {obsolete_fragment}")

if "features: boundary.geojson.features.filter(feature => feature.properties?.feature_kind === 'boundary_sao')" not in page:
    raise SystemExit("The print layout must calculate its view from the complete SAO boundary.")

print("Reference print static checks passed.")
