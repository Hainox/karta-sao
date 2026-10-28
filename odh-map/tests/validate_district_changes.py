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
    "object numbering": "function assignObjectNo(feature, features)",
    "object badge": "function badgeFor(feature, index)",
    "object description": "function describeFor(feature)",
    "group labels": "GROUP_LABELS",
}
missing = [name for name, text in required_script.items() if text not in script]
if missing:
    raise SystemExit("Missing shared change-set requirements: " + ", ".join(missing))

labels_path = root / "object-labels.js"
if not labels_path.is_file():
    raise SystemExit("Missing shared object-labels module.")
labels = labels_path.read_text(encoding="utf-8")
required_labels = {
    "module": "window.ODHObjectLabels",
    "label text": "function labelText(",
    "object card": "function popupHtml(",
    "attach": "function attach(",
    "mode switch": "function setMode(",
    "mode toggle": "function renderToggle(",
    "type legend": "function renderLegend(",
    "dense-set default": "function modeForCount(",
}
missing = [name for name, text in required_labels.items() if text not in labels]
if missing:
    raise SystemExit("Object labels module is missing: " + ", ".join(missing))

print("District change static checks passed.")

review_path = root / "district-review.html"
if not review_path.is_file():
    raise SystemExit("Missing district review page.")
review = review_path.read_text(encoding="utf-8")
for label in ("multiple", "review_bundle_version", "DistrictChanges.REVIEW_VERSION", "Скачать сводку", "DistrictChanges.validate", "accepted_locally", "reconcileDistrict", "Выбрать актуальным", "conflictCount", "object-labels.js", "ODHObjectLabels.attach", "ODHObjectLabels.renderLegend", "renderObjectJournal", "objectJournal", "labelsToggle", "typeLegend"):
    if label not in review:
        raise SystemExit(f"District review is missing: {label}")
