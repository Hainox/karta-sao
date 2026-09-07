from pathlib import Path


root = Path(__file__).resolve().parents[1]
script_path = root / "district-changes.js"

if not script_path.is_file():
    raise SystemExit("Missing shared district-change validator.")

script = script_path.read_text(encoding="utf-8")
required_script = {
    "format version": "district_change_set_v1",
    "validator": "function validate(changeSet, boundary)",
    "review-bundle validator": "function validateReviewBundle(bundle, boundary)",
    "boundary check": "function vertexInBoundary",
    "visual styles": "function styleFor(feature)",
}
missing = [name for name, text in required_script.items() if text not in script]
if missing:
    raise SystemExit("Missing shared change-set requirements: " + ", ".join(missing))

print("District change static checks passed.")

editor_path = root / "district-editor.html"
if not editor_path.is_file():
    raise SystemExit("Missing district editor page.")
editor = editor_path.read_text(encoding="utf-8")
for label in ("localStorage", "Экспортировать правки", "Роторная перекидка"):
    if label not in editor:
        raise SystemExit(f"District editor is missing: {label}")

review_path = root / "district-review.html"
if not review_path.is_file():
    raise SystemExit("Missing district review page.")
review = review_path.read_text(encoding="utf-8")
for label in ("multiple", "district_review_bundle_v1", "Скачать единый GeoJSON", "DistrictChanges.validate", "accepted_locally"):
    if label not in review:
        raise SystemExit(f"District review is missing: {label}")

index = (root / "index.html").read_text(encoding="utf-8")
overlay_path = root / "district-overlay.js"
if "Наложить правки района" not in index or "district-overlay.js" not in index:
    raise SystemExit("Main map has no district-overlay entry point.")
if not overlay_path.is_file():
    raise SystemExit("Missing district overlay script.")
overlay = overlay_path.read_text(encoding="utf-8")
for label in ("Временное наложение", "clearDistrictOverlay", "MAX_BYTES", "MAX_BUNDLE_BYTES", "validateReviewBundle"):
    if label not in overlay:
        raise SystemExit(f"District overlay is missing: {label}")
