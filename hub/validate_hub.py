"""Minimal offline validation for the static map hub."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
HUB_DIR = Path(__file__).resolve().parent
page = (HUB_DIR / "index.html").read_text(encoding="utf-8")


class HubCardParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.targets = []

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        classes = attributes.get("class", "").split()
        if tag == "a" and "map-card" in classes:
            self.targets.append(attributes.get("href", ""))


parser = HubCardParser()
parser.feed(page)
assert parser.targets, "No map cards found in hub/index.html"
assert "<iframe" not in page.lower()

for route in (
    "../",
    "../odh-map/",
    "../yards-print/",
    "../odh-map/print-a3.html",
    "../odh-map/print-1000x1400.html",
):
    assert route in parser.targets, f"Missing hub card route: {route}"

for target in parser.targets:
    parsed = urlsplit(target)
    assert parsed.path, f"Card is missing a destination: {target}"
    assert not parsed.scheme and not parsed.netloc, f"Expected a local card route: {target}"
    destination = (HUB_DIR / unquote(parsed.path)).resolve()
    assert destination.is_relative_to(ROOT), f"Card route escapes the site: {target}"
    if destination.is_dir():
        destination /= "index.html"
    assert destination.is_file(), f"Missing card target: {target}"

print(f"Hub static checks: OK ({len(parser.targets)} map cards; local targets resolve)")
