"""Ищет битые ссылки на ресурсы во всех страницах атласа.

Разбирает относительные src/href/url() в html и css проекта и проверяет,
что файл действительно есть в репозитории. Внешние адреса не проверяются.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

SKIP_DIRS = {"node_modules", ".git", "work", "projects", "photo-service", "dist", "outputs", "rendered"}
PAGES = [
    "index.html",
    "hub/index.html",
    "odh-map/index.html",
    "odh-map/district-links.html",
    "odh-map/district-editor.html",
    "odh-map/district-review.html",
    "odh-map/prefecture-guide.html",
    "odh-map/print-a3.html",
    "odh-map/print-a1.html",
    "odh-map/print-1000x1400.html",
    "yards-print/index.html",
    "yards-print/print-a1.html",
    "smm/index.html",
    "smm/print-a3.html",
    "object-maps/index.html",
    "object-maps/stops.html",
    "object-maps/pp.html",
    "object-maps/entrances.html",
    "markup/index.html",
]

ATTRIBUTE = re.compile(r'(?:src|href)\s*=\s*["\']([^"\']+)["\']', re.IGNORECASE)
CSS_URL = re.compile(r'url\(\s*["\']?([^"\')]+)["\']?\s*\)', re.IGNORECASE)

# Адреса, которые обязаны отвечать на проде, а не лежать файлом: их проверяет живой аудит.
DYNAMIC = re.compile(r"^(?:https?:|data:|mailto:|tel:|javascript:|#|//)", re.IGNORECASE)


def local_targets(text, pattern):
    for match in pattern.finditer(text):
        value = match.group(1).strip()
        if not value or DYNAMIC.match(value):
            continue
        yield value.split("?")[0].split("#")[0]


def check_page(path):
    missing = []
    seen = set()
    text = path.read_text(encoding="utf-8", errors="ignore")
    for target in list(local_targets(text, ATTRIBUTE)) + list(local_targets(text, CSS_URL)):
        if not target:
            continue
        resolved = (path.parent / target).resolve()
        key = (target, resolved)
        if key in seen:
            continue
        seen.add(key)
        if not resolved.exists():
            missing.append(target)
    return missing


def main():
    problems = 0
    checked = 0
    for relative in PAGES:
        path = ROOT / relative
        if not path.exists():
            print(f"НЕТ САМОЙ СТРАНИЦЫ: {relative}")
            problems += 1
            continue
        checked += 1
        missing = check_page(path)
        if missing:
            problems += len(missing)
            print(f"{relative}:")
            for target in missing:
                print(f"    битая ссылка: {target}")
    print(f"\nстраниц проверено: {checked}; битых ссылок: {problems}")

    print("\n=== ссылки между страницами (переходы с карточек хаба) ===")
    hub = (ROOT / "hub/index.html").read_text(encoding="utf-8", errors="ignore")
    cards = re.findall(r'<a[^>]+class="map-card"[^>]*href="([^"]+)"', hub)
    for href in cards:
        target = (ROOT / "hub" / href).resolve()
        exists = target.exists() or target.is_dir()
        print(f"  {'ok  ' if exists else 'FAIL'} {href} -> {'есть' if exists else 'НЕТ'}")


if __name__ == "__main__":
    main()
