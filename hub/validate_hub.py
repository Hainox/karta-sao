"""Minimal offline validation for the static map hub."""
from pathlib import Path

page = Path(__file__).with_name("index.html").read_text(encoding="utf-8")
for required in ("Дворы и участки САО", "ОДХ и очередность", "../odh-map/", "map-frame", "history.replaceState"):
    assert required in page, f"Missing hub element: {required}"
assert page.count('class="map-card"') == 3
print("Hub static checks: OK (3 map directions)")
