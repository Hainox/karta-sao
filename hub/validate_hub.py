"""Minimal offline validation for the static map hub."""
from pathlib import Path

page = Path(__file__).with_name("index.html").read_text(encoding="utf-8")
for route in ("../", "../odh-map/", "../yards-print/", "../odh-map/print-a3.html"):
    assert route in page, f"Missing hub route: {route}"
assert "<iframe" not in page
assert page.count('class="map-card"') == 7
print("Hub static checks: OK (4 map directions)")
