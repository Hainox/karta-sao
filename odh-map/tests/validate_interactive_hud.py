from pathlib import Path


page = (Path(__file__).resolve().parents[1] / "index.html").read_text(encoding="utf-8")

required_fragments = {
    "selected HUD title": "Карта маршрутов ОДХ САО",
    "district-editor link": "district-editor.html",
    "print link": "print-1000x1400.html",
    "SAO extent action": "На всю территорию САО",
    "layer controls": "Слои и условные обозначения",
    "direction control": "Показывать направление движения",
    "route arrows": "L.Symbol.arrowHead",
    "object drawer": 'id="drawer"',
    "search": 'id="search"',
    "temporary overlay": 'for="overlay-input"',
    "SAO-only boundary filter": "feature.properties?.feature_kind === \"boundary_sao\"",
    "published queue total": "queue1: 98, queue2: 318, queue3: 272",
    "map pan and wheel support": 'L.map("map"',
}

missing = [name for name, fragment in required_fragments.items() if fragment not in page]
if missing:
    raise SystemExit("Missing interactive HUD requirements: " + ", ".join(missing))

print("Interactive HUD static checks passed.")
