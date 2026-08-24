# Unified SAO Hub, Yard Map and Print Forms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a standalone hub catalog, a visually unified interactive yard map, and A3 printing for all SAO yards or a selected district/section.

**Architecture:** Preserve the current Yandex Maps v3 engine and real GeoJSON data in the root map. Add a dedicated `/yards-print/` entry point that reads the same manifest/data and applies URL filters. The `/hub/` entry point becomes navigation only; it never embeds a map.

**Tech Stack:** Static HTML, CSS, vanilla JavaScript, Yandex Maps JS API v3, GeoJSON, Python 3.14 and pytest.

**Spec:** `projects/map-atlas/docs/superpowers/specs/2026-08-24-sao-map-atlas-design.md`

## Global Constraints

- Keep `/`, `/odh-map/` and `/odh-map/print-a3.html` working; do not remove existing public URLs.
- Use the shared atlas shell: герб САО, Century Gothic as an optional system-font stack only, 44 px minimum interactive controls, responsive desktop/mobile layout.
- Do not copy or publish a font file without a license.
- Keep Yandex Maps API key out of new source files and verify its Referer settings before production release.
- `/hub/` is a list of links only: no iframe and no nested map controls.
- `/yards-print/` supports `district` and `section` URL parameters and `@page { size: A3 landscape }`.
- Publish only web assets; do not stage `projects/odh-yandex-export/work`, raw source data or credentials.

---

### Task 1: Add regression checks for the public atlas routes

**Files:**
- Create: `tests/test_public_atlas_pages.py`
- Modify: none

**Interfaces:**
- Consumes: root `index.html`, `hub/index.html` and future `yards-print/index.html`.
- Produces: `pytest` checks that guard all public route markup.

- [ ] **Step 1: Write the failing test**

```python
from pathlib import Path


def page(relative: str) -> str:
    return Path(relative).read_text(encoding="utf-8")


def test_yard_and_print_pages_declare_shared_atlas_shell():
    for path in ("index.html", "yards-print/index.html"):
        markup = page(path)
        assert "Городской атлас САО" in markup
        assert "brand-mark" in markup
        assert "@page{size:A3 landscape" in page("yards-print/index.html")


def test_hub_is_navigation_only_and_has_two_catalog_sections():
    markup = page("hub/index.html")
    assert "Рабочие карты" in markup
    assert "Печатные формы" in markup
    assert "../yards-print/" in markup
    assert "<iframe" not in markup
```

- [ ] **Step 2: Run test to verify it fails**

Run: `py -3.14 -m pytest tests/test_public_atlas_pages.py -q`

Expected: FAIL because `yards-print/index.html` does not exist and the current hub contains an iframe.

- [ ] **Step 3: Keep this exact route contract**

The implementation tasks must make all four assertions true without changing the test names or weakening assertions.

- [ ] **Step 4: Run test to verify it passes after Tasks 2–4**

Run: `py -3.14 -m pytest tests/test_public_atlas_pages.py -q`

Expected: `2 passed`.

- [ ] **Step 5: Commit with the first completed implementation task**

```powershell
git add tests/test_public_atlas_pages.py index.html
git commit -m "feat: unify yard map atlas shell"
```

### Task 2: Apply the atlas shell to the interactive yard map

**Files:**
- Modify: `index.html`
- Test: `tests/test_public_atlas_pages.py`

**Interfaces:**
- Consumes: existing `COLOR_LEGEND`, `LAYER_CONFIG`, `renderDistrictSelect`, `renderSectionSelect`, `renderLayerControls`, `renderVisibleFeatures` and Yandex Maps initialization.
- Produces: the unchanged functions remain callable; the markup gains `topbar`, `workspace`, `sidebar`, `panel-heading`, `status`, `map-wrap` and `map-overlay`.

- [ ] **Step 1: Preserve the map data interface before editing layout**

Confirm the following existing JavaScript identifiers are retained exactly: `COLOR_LEGEND`, `LAYER_CONFIG`, `renderDistrictSelect`, `renderSectionSelect`, `renderLayerControls`, `renderVisibleFeatures`, `fitToData`.

- [ ] **Step 2: Replace only the visual shell around the existing controls**

Add this structural hierarchy while keeping current control IDs intact:

```html
<div class="app">
  <header class="topbar">…<span class="brand-mark" aria-label="Герб САО"></span>…</header>
  <main class="workspace">
    <aside class="sidebar"><div class="panel-heading">…</div>…</aside>
    <section class="map-wrap"><div id="map"></div><div class="map-overlay">…</div></section>
  </main>
</div>
```

Use `font-family:"Century Gothic",Inter,Arial,sans-serif` and embed the already approved local герб asset as a data-URI or a same-origin image. Do not add the Yandex API key to any new file.

- [ ] **Step 3: Add responsive and accessibility styles**

Implement CSS so `.workspace` is `grid-template-columns:350px minmax(0,1fr)` on desktop and one column below 780 px. Set `min-height:44px` on selects, layer toggles and buttons. Retain labels linked to `districtSelect` and `sectionSelect`.

- [ ] **Step 4: Add the print navigation button**

Place a visible button with this exact destination next to map actions:

```html
<a class="printbtn" href="yards-print/">Печать / PDF A3</a>
```

- [ ] **Step 5: Run regression checks**

Run: `py -3.14 -m pytest tests/test_public_atlas_pages.py -q`

Expected: one test still fails only because the print route and final hub design are not complete.

- [ ] **Step 6: Commit**

```powershell
git add index.html tests/test_public_atlas_pages.py
git commit -m "feat: unify yard map atlas shell"
```

### Task 3: Create filtering A3 print page for yards

**Files:**
- Create: `yards-print/index.html`
- Test: `tests/test_public_atlas_pages.py`

**Interfaces:**
- Consumes: `../areas.geojson`, `../mno.geojson`, `../dp.geojson`, `../sp.geojson`; `district` and `section` query parameters.
- Produces: `parsePrintFilters(search: string) -> {district: string, section: string}` and `matchesPrintFilter(properties, filters) -> boolean` in page JavaScript.

- [ ] **Step 1: Write inline unit assertions before map initialization**

Add the following dev-time tests guarded by `location.hostname === "localhost"`:

```js
console.assert(parsePrintFilters("?district=Войковский&section=Участок%201").district === "Войковский");
console.assert(matchesPrintFilter({district:"Войковский",section:"Участок 1"},{district:"Войковский",section:"Участок 1"}));
console.assert(!matchesPrintFilter({district:"Аэропорт",section:"Участок 1"},{district:"Войковский",section:""}));
```

- [ ] **Step 2: Create the A3 page shell and data loader**

Use the same topbar/brand/sidebar design as the interactive yard map. Implement:

```js
function parsePrintFilters(search) {
  const params = new URLSearchParams(search);
  return { district: params.get("district") || "", section: params.get("section") || "" };
}
function matchesPrintFilter(properties, filters) {
  return (!filters.district || properties.district === filters.district)
    && (!filters.section || properties.section === filters.section);
}
```

Fetch the four relative GeoJSON files, filter features with `matchesPrintFilter`, render the visible layers and fit bounds to the filtered result. If a fetch fails, render a visible error panel naming the failed URL.

- [ ] **Step 3: Add user controls and shareable URL updates**

Provide district and section selects plus a button labeled `Печать / PDF A3`. When a select changes, call:

```js
const url = new URL(location.href);
url.searchParams.set("district", districtSelect.value);
url.searchParams.set("section", sectionSelect.value);
history.replaceState({}, "", url);
```

Do not write empty `district` or `section` parameters; delete them with `url.searchParams.delete`.

- [ ] **Step 4: Add print CSS**

Include `@page{size:A3 landscape;margin:8mm}`. In `@media print`, hide interactive buttons and retain title, active filters, legend, map and data date. Ensure the map area is at least 250 mm tall.

- [ ] **Step 5: Run static tests and manual HTTP smoke test**

Run:

```powershell
py -3.14 -m pytest tests/test_public_atlas_pages.py -q
py -3.14 -m http.server 8000
```

Open `http://localhost:8000/yards-print/?district=Войковский` and verify a district label, filtered map and browser print preview.

- [ ] **Step 6: Commit**

```powershell
git add yards-print/index.html tests/test_public_atlas_pages.py
git commit -m "feat: add A3 yard print map"
```

### Task 4: Convert hub to a navigation-only catalog

**Files:**
- Modify: `hub/index.html`
- Modify: `hub/validate_hub.py`
- Test: `tests/test_public_atlas_pages.py`

**Interfaces:**
- Consumes: stable routes `../`, `../odh-map/`, `../yards-print/`, `../odh-map/print-a3.html`.
- Produces: four anchor links; no JavaScript map loading API and no iframe.

- [ ] **Step 1: Write the failing hub assertion**

In `hub/validate_hub.py`, replace the current frame-oriented requirement with:

```python
for route in ("../", "../odh-map/", "../yards-print/", "../odh-map/print-a3.html"):
    assert route in page
assert "<iframe" not in page
assert page.count('class="map-card"') == 4
```

- [ ] **Step 2: Run hub validator to verify it fails**

Run: `py -3.14 hub/validate_hub.py`

Expected: FAIL because the present hub has an iframe and only three cards.

- [ ] **Step 3: Replace the workspace with two catalog blocks**

Render semantic anchors, not buttons:

```html
<section aria-labelledby="interactive-heading">
  <h2 id="interactive-heading">Рабочие карты</h2>
  <a class="map-card" href="../">…</a>
  <a class="map-card" href="../odh-map/">…</a>
</section>
<section aria-labelledby="print-heading">
  <h2 id="print-heading">Печатные формы</h2>
  <a class="map-card" href="../yards-print/">…</a>
  <a class="map-card" href="../odh-map/print-a3.html">…</a>
</section>
```

Remove `map-frame`, `selectMap`, reload control and all iframe CSS. Keep the atlas brand and add compact descriptions, data scope and a direct link on every card.

- [ ] **Step 4: Run all static checks**

Run:

```powershell
py -3.14 hub/validate_hub.py
py -3.14 -m pytest tests/test_public_atlas_pages.py -q
```

Expected: hub validator reports four directions and pytest reports `2 passed`.

- [ ] **Step 5: Commit**

```powershell
git add hub/index.html hub/validate_hub.py tests/test_public_atlas_pages.py
git commit -m "feat: simplify SAO map hub catalog"
```

### Task 5: Verify the Yandex key and publish only public assets

**Files:**
- Modify: none unless a Referer rule in Yandex Developer requires a user-approved dashboard change.
- Test: public HTTP checks.

**Interfaces:**
- Consumes: GitHub Pages `main` deployment and Yandex key configured in the existing root page.
- Produces: working `/`, `/yards-print/`, `/odh-map/`, `/odh-map/print-a3.html`, `/hub/` URLs.

- [ ] **Step 1: Verify allowed Referer before release**

In Yandex Developer, verify that the existing key permits `https://hainox.github.io/*`. If it does not, stop and request explicit approval before changing the third-party key settings.

- [ ] **Step 2: Verify selected Git staging**

Run:

```powershell
git diff --cached --check
git status --short
```

Expected: staged files are only `index.html`, `yards-print/`, `hub/`, `odh-map/` and test files; no `projects/odh-yandex-export/work` files are staged.

- [ ] **Step 3: Push after explicit user approval**

```powershell
git push origin main
```

- [ ] **Step 4: Verify five production routes**

Run:

```powershell
$urls=@('https://hainox.github.io/karta-sao/','https://hainox.github.io/karta-sao/yards-print/','https://hainox.github.io/karta-sao/odh-map/','https://hainox.github.io/karta-sao/odh-map/print-a3.html','https://hainox.github.io/karta-sao/hub/')
$urls | ForEach-Object { (Invoke-WebRequest -Uri $_ -UseBasicParsing).StatusCode }
```

Expected: five `200` responses. Manually check that Yandex map loads, print routes show an A3 preview, and the hub never nests a map.

- [ ] **Step 5: Commit any post-release documentation only**

```powershell
git add README.md
if (-not (git diff --cached --quiet)) { git commit -m "docs: add SAO atlas routes" }
```

## Execution Handoff

Plan complete. Execute with either:

1. **Subagent-Driven (recommended):** a fresh worker per task, followed by review before the next task.
2. **Inline Execution:** execute tasks in this session in order, preserving the test and commit gates listed above.

No production push occurs until the user explicitly approves the final staged release.
