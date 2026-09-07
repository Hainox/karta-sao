# District Change Editor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a browser-only district editor and safe overlay importer for proposed ODH map changes.

**Architecture:** A shared browser script validates the `district_change_set_v1` GeoJSON format and checks every coordinate against the published SAO boundary. The district editor uses it to create, save and export drafts; the public map uses it only to render a selected proposal as a temporary overlay.

**Tech Stack:** Vanilla HTML/CSS/JavaScript, Leaflet 1.9.4, Leaflet.Draw 1.0.4, GeoJSON, browser localStorage, Python static tests.

**Spec:** `docs/superpowers/specs/2026-09-07-district-change-editor-design.md`

## Global Constraints

- The MVP must not write to GitHub, a server or the published source layers.
- GeoJSON format version is exactly `district_change_set_v1`.
- Maximum input is 5 MB and 500 features.
- Permitted geometry is only `Point` or `LineString` and all vertices must be within the published SAO boundary.
- Editor drafts persist only in the local browser; imported overlays disappear on a main-map reload.

---

### Task 1: Shared validation and style contract

**Files:**
- Create: `odh-map/district-changes.js`
- Create: `odh-map/tests/validate_district_changes.py`

**Interfaces:**
- Produces `window.DistrictChanges.validate(changeSet, boundary): { valid: boolean, errors: string[] }`.
- Produces `window.DistrictChanges.styleFor(feature): { color: string, dashArray?: string }`.
- Consumes a boundary `FeatureCollection` and a candidate `FeatureCollection`.

- [ ] **Step 1: Write failing static test**

```python
assert 'district_change_set_v1' in script
assert 'function validate(changeSet, boundary)' in script
assert 'function vertexInBoundary' in script
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python odh-map/tests/validate_district_changes.py`
Expected: failure because the shared script does not exist.

- [ ] **Step 3: Implement format validation**

Create a browser-global script with the valid district names, valid line and point change types, ray-casting polygon containment, feature-limit/field/type checks, and non-mutating visual styles for proposal features.

- [ ] **Step 4: Run test to verify it passes**

Run: `python odh-map/tests/validate_district_changes.py`
Expected: `District change static checks passed.`

- [ ] **Step 5: Commit**

```bash
git add odh-map/district-changes.js odh-map/tests/validate_district_changes.py
git commit -m "Add district change validation contract"
```

### Task 2: District browser editor

**Files:**
- Create: `odh-map/district-editor.html`
- Modify: `odh-map/index.html`
- Test: `odh-map/tests/validate_district_changes.py`

**Interfaces:**
- Consumes `DistrictChanges.validate`, `DistrictChanges.styleFor` and `layers/sao_boundary_wgs84.geojson`.
- Produces download files named `pravki-<district>-<date>.geojson`.

- [ ] **Step 1: Extend failing static test**

```python
assert (root / 'district-editor.html').is_file()
assert 'localStorage' in editor
assert 'Экспортировать правки' in editor
assert 'Роторная перекидка' in editor
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python odh-map/tests/validate_district_changes.py`
Expected: failure because the editor page does not exist.

- [ ] **Step 3: Implement editor**

Add a focused Leaflet.Draw page with a district selector, author, type, address and comment fields. Restrict draw controls according to selected point/line type; apply properties during creation; persist only current browser draft; validate on import/export; show clear feature list and delete action.

- [ ] **Step 4: Link from main map**

Add an explicit `Подготовить правки района` link to the existing action area without changing layer data or print behaviour.

- [ ] **Step 5: Run test to verify it passes**

Run: `python odh-map/tests/validate_district_changes.py`
Expected: `District change static checks passed.`

- [ ] **Step 6: Commit**

```bash
git add odh-map/district-editor.html odh-map/index.html odh-map/tests/validate_district_changes.py
git commit -m "Add district map change editor"
```

### Task 3: Temporary overlay on the main map

**Files:**
- Modify: `odh-map/index.html`
- Create: `odh-map/district-overlay.js`
- Test: `odh-map/tests/validate_district_changes.py`

**Interfaces:**
- Consumes a validated `district_change_set_v1` file and global `map`, `boundaryBounds`, and `groups` from the existing map.
- Produces a Leaflet layer group named `districtProposalOverlay` that can be hidden or cleared without source writes.

- [ ] **Step 1: Extend failing static test**

```python
assert 'Наложить правки района' in index
assert 'district-overlay.js' in index
assert 'Временное наложение' in overlay
assert 'clearDistrictOverlay' in overlay
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python odh-map/tests/validate_district_changes.py`
Expected: failure because the overlay controls and script do not exist.

- [ ] **Step 3: Implement overlay importer**

Inject a compact file control after the existing main-map actions. Read only a selected local file, enforce the 5 MB cap, validate it against the boundary, render it as a labelled dashed line/marker group, report district/author/date, and provide hide/show/clear actions. Never call `fetch` or a write API for the imported file.

- [ ] **Step 4: Run all verification**

Run: `py -m pytest tests odh-map/tests -q` with the temporary Shapely path and `python odh-map/tests/validate_district_changes.py`.
Expected: all project tests pass and district static checks pass.

- [ ] **Step 5: Browser verification**

Open `district-editor.html`, create a queue line and storage point, export and import the file into `index.html`, then reload `index.html` to confirm the overlay disappears.

- [ ] **Step 6: Commit**

```bash
git add odh-map/index.html odh-map/district-overlay.js odh-map/tests/validate_district_changes.py
git commit -m "Add temporary district proposal overlays"
```
