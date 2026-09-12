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
for label in ("localStorage", "Скачать GeoJSON", "Проверить перед отправкой", "route-visuals.js", "НАЧ.", "направление движения техники"):
    if label not in editor:
        raise SystemExit(f"District editor is missing: {label}")

review_path = root / "district-review.html"
if not review_path.is_file():
    raise SystemExit("Missing district review page.")
review = review_path.read_text(encoding="utf-8")
for label in ("multiple", "review_bundle_version", "DistrictChanges.REVIEW_VERSION", "Скачать сводку", "DistrictChanges.validate", "accepted_locally", "reconcileDistrict", "Выбрать актуальным", "conflictCount"):
    if label not in review:
        raise SystemExit(f"District review is missing: {label}")

index = (root / "index.html").read_text(encoding="utf-8")
if "district-links.html" not in index or "Районам: начать разметку" not in index:
    raise SystemExit("Main map has no district drawing entry point.")
