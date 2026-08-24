# ODH Symbol System and External Layer Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace ODH circular markers with approved SVG legend symbols, preserve geometry, add legal tile attribution, and ship ODH as a small HTML shell with externally loaded GeoJSON layers.

**Architecture:** Keep `build_sao_maps.py` as the source generator but separate generated HTML from GeoJSON. A publish-bundle function writes `odh-map/index.html`, `odh-map/print-a3.html`, `odh-map/layers.json` and only the GeoJSON layers used by the browser. The browser fetches the manifest then layers, renders the same Leaflet groups and exposes retryable load states.

**Tech Stack:** Python 3.14, pytest, vanilla JavaScript, Leaflet, CARTO/OSM data attribution, GeoJSON.

**Spec:** `projects/map-atlas/docs/superpowers/specs/2026-08-24-sao-map-atlas-design.md`

## Global Constraints

- Preserve all ODH geometry; only change visual representation of point features.
- No `L.circleMarker` for ODH thematic point symbols.
- Use approved colors: boundary `#6a1b9a`, first wave `#e53935`, remaining `#757575`, PGM `#c05600`, snow `#039be5`, healthcare `#c62828`.
- Keep the compact `© OpenStreetMap contributors · © CARTO` attribution with links visible on public ODH maps.
- Keep Leaflet branding out of the visual interface.
- Do not stage raw work files or credentials in the GitHub Pages bundle.

---

### Task 1: Add tests for ODH SVG symbols and attribution

**Files:**
- Create: `projects/odh-yandex-export/tests/test_odh_symbols.py`
- Modify: `projects/odh-yandex-export/tests/test_build_sao_maps.py`

**Interfaces:**
- Consumes: `scripts.build_sao_maps.symbol_svg(kind, color)` and `render_html`.
- Produces: regression expectations for six symbols, no circle marker and visible attribution.

- [ ] **Step 1: Write failing tests**

```python
from scripts.build_sao_maps import symbol_svg, render_html


def test_symbol_svg_uses_approved_shapes_and_colors():
    assert 'data-kind="road"' in symbol_svg("wave1", "#e53935")
    assert 'data-kind="container"' in symbol_svg("pgm", "#c05600")
    assert 'data-kind="snowflake"' in symbol_svg("snow", "#039be5")
    assert 'data-kind="medical"' in symbol_svg("healthcare", "#c62828")


def test_generated_map_has_no_circle_marker_and_has_required_attribution():
    markup = render_html([], mode="interactive")
    assert "L.circleMarker" not in markup
    assert "© OpenStreetMap contributors" in markup
    assert "© CARTO" in markup
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `py -3.14 -m pytest tests/test_odh_symbols.py -q`

Expected: FAIL because `symbol_svg` does not exist and current JavaScript creates circle markers.

- [ ] **Step 3: Implement the symbol API**

Create a deterministic generator:

```python
def symbol_svg(kind: str, color: str) -> str:
    icon = {"wave1":"road", "remaining":"road", "pgm":"container", "snow":"snowflake", "healthcare":"medical"}[kind]
    return f'<svg data-kind="{icon}" viewBox="0 0 24 24" aria-hidden="true" style="--symbol-color:{color}">…</svg>'
```

Use a road glyph for `wave1` and `remaining`; their different colors distinguish priority. Implement inline paths only; do not add an icon library.

- [ ] **Step 4: Replace Leaflet circle markers with div icons**

Generate JavaScript that uses:

```js
pointToLayer:(feature,latlng)=>L.marker(latlng,{icon:L.divIcon({className:'odh-symbol-marker',html:feature.properties.__symbolSvg,iconSize:[24,24],iconAnchor:[12,12]})})
```

Inject `__symbolSvg` only for point features. In `onEachFeature`, keep geometry and popup handling unchanged.

- [ ] **Step 5: Add compact attribution markup**

Add this map-local HTML after `#map`:

```html
<div class="map-attribution">© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a> · © <a href="https://carto.com/attributions" target="_blank" rel="noopener">CARTO</a></div>
```

Position it at the bottom-right above the map edge, with 9 px text and a translucent neutral background. Do not hide it in print CSS.

- [ ] **Step 6: Run symbol tests**

Run: `py -3.14 -m pytest tests/test_odh_symbols.py tests/test_build_sao_maps.py -q`

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add projects/odh-yandex-export/scripts/build_sao_maps.py projects/odh-yandex-export/tests/test_odh_symbols.py projects/odh-yandex-export/tests/test_build_sao_maps.py
git commit -m "feat: add ODH legend symbols and attribution"
```

### Task 2: Add an external ODH layer manifest and bundle writer

**Files:**
- Create: `projects/odh-yandex-export/scripts/publish_odh_pages.py`
- Create: `projects/odh-yandex-export/tests/test_publish_odh_pages.py`

**Interfaces:**
- Consumes: output GeoJSON named by `SPECS` and generated HTML shells.
- Produces: `build_publish_bundle(source_dir: Path, destination: Path) -> list[Path]`, `layers.json`, `layers/<filename>`.

- [ ] **Step 1: Write the failing bundle test**

```python
import json
from pathlib import Path
from scripts.publish_odh_pages import build_publish_bundle


def test_build_publish_bundle_writes_shell_manifest_and_layers(tmp_path):
    source = tmp_path / "source"; source.mkdir()
    for name in ("sao_boundary_wgs84.geojson", "sao_wave1_complete_wgs84.geojson"):
        (source / name).write_text('{"type":"FeatureCollection","features":[]}', encoding="utf-8")
    created = build_publish_bundle(source, tmp_path / "site")
    manifest = json.loads((tmp_path / "site" / "layers.json").read_text(encoding="utf-8"))
    assert (tmp_path / "site" / "index.html") in created
    assert manifest["layers"][0]["url"].startswith("layers/")
    assert "FeatureCollection" in (tmp_path / "site" / manifest["layers"][0]["url"]).read_text(encoding="utf-8")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `py -3.14 -m pytest tests/test_publish_odh_pages.py -q`

Expected: FAIL because `publish_odh_pages` is absent.

- [ ] **Step 3: Implement the exact bundle function**

`build_publish_bundle` must create `destination/layers`, copy only files present in `source_dir`, and write this schema:

```json
{"layers":[{"key":"boundary","name":"Граница САО","color":"#6a1b9a","default":true,"url":"layers/sao_boundary_wgs84.geojson"}]}
```

Return paths for the two shells, manifest and each copied layer. Raise `FileNotFoundError` naming the source file if a required default layer is missing.

- [ ] **Step 4: Run the bundle test to verify it passes**

Run: `py -3.14 -m pytest tests/test_publish_odh_pages.py -q`

Expected: `1 passed`.

- [ ] **Step 5: Commit**

```powershell
git add projects/odh-yandex-export/scripts/publish_odh_pages.py projects/odh-yandex-export/tests/test_publish_odh_pages.py
git commit -m "feat: build external ODH layer bundle"
```

### Task 3: Load manifest and layers asynchronously in ODH shells

**Files:**
- Modify: `projects/odh-yandex-export/scripts/build_sao_maps.py`
- Modify: `projects/odh-yandex-export/tests/test_build_sao_maps.py`

**Interfaces:**
- Consumes: `layers.json` schema from Task 2.
- Produces: `loadMapLayers() -> Promise<void>` in generated JavaScript and a visible `#load-status` state.

- [ ] **Step 1: Add a failing shell test**

```python
def test_odH_shell_fetches_manifest_and_displays_retryable_load_status():
    markup = render_html([], mode="interactive")
    assert "fetch('layers.json')" in markup
    assert "async function loadMapLayers()" in markup
    assert 'id="load-status"' in markup
    assert "Повторить загрузку" in markup
```

- [ ] **Step 2: Run test to verify it fails**

Run: `py -3.14 -m pytest tests/test_build_sao_maps.py -q`

Expected: FAIL because GeoJSON is currently embedded in `const DATA`.

- [ ] **Step 3: Render a lightweight shell**

Replace embedded `const DATA` with:

```js
async function loadMapLayers(){
  setLoadStatus('Загрузка слоёв…');
  const manifest=await fetch('layers.json').then(assertOk).then(r=>r.json());
  const loaded=await Promise.all(manifest.layers.map(async layer=>({...layer,geojson:await fetch(layer.url).then(assertOk).then(r=>r.json())})));
  addLayers(loaded); setLoadStatus(`Готово: ${loaded.length} слоёв.`);
}
```

Implement `assertOk(response)` to throw `Error(response.url + ': HTTP ' + response.status)` when `!response.ok`. On failure show the error and a button `Повторить загрузку` that calls `loadMapLayers()` after clearing existing layer groups.

- [ ] **Step 4: Keep print shell compatible**

`print-a3.html` uses the same manifest and layer loader. It waits for `loadMapLayers()` before `window.print()` can be initiated. It retains `@page{size:A3 landscape`.

- [ ] **Step 5: Run all ODH tests**

Run: `py -3.14 -m pytest tests -q`

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add projects/odh-yandex-export/scripts/build_sao_maps.py projects/odh-yandex-export/tests
git commit -m "perf: load ODH GeoJSON layers on demand"
```

### Task 4: Build, inspect and deploy the ODH release bundle

**Files:**
- Modify: `odh-map/index.html`
- Modify: `odh-map/print-a3.html`
- Create: `odh-map/layers.json`
- Create: `odh-map/layers/*.geojson`

**Interfaces:**
- Consumes: `projects/odh-yandex-export/outputs` and Task 2 bundle writer.
- Produces: GitHub Pages ODH release assets only.

- [ ] **Step 1: Generate local ODH outputs and public bundle**

Run:

```powershell
Set-Location projects/odh-yandex-export
py -3.14 scripts/build_sao_maps.py --data-dir work/map_data --output-dir outputs
py -3.14 scripts/publish_odh_pages.py --source-dir outputs --destination-dir ..\..\odh-map
```

- [ ] **Step 2: Validate assets and size reduction**

Run:

```powershell
py -3.14 -m pytest tests -q
Get-Item ..\..\odh-map\index.html, ..\..\odh-map\layers.json
Get-ChildItem ..\..\odh-map\layers\*.geojson | Measure-Object
```

Expected: HTML shell is materially smaller than embedded-data version; manifest exists and every default layer URL exists.

- [ ] **Step 3: Verify precise staging**

Run:

```powershell
Set-Location ..\..
git add -- odh-map
$staged = git diff --cached --name-only
if ($staged | Where-Object { $_ -like 'projects/odh-yandex-export/work/*' }) { throw 'Raw work data must not be staged' }
git diff --cached --check
```

- [ ] **Step 4: Push after explicit user approval and verify production**

Run:

```powershell
git push origin main
Invoke-WebRequest -Uri 'https://hainox.github.io/karta-sao/odh-map/' -UseBasicParsing
Invoke-WebRequest -Uri 'https://hainox.github.io/karta-sao/odh-map/layers.json' -UseBasicParsing
```

Expected: both return `200`; visually verify no circular thematic markers, six legend symbols, attribution and layer retry handling.

- [ ] **Step 5: Commit generated release assets if not committed in Task 3**

```powershell
git add odh-map
git commit -m "build: publish optimized ODH map layers"
```

## Execution Handoff

Plan complete. Execute with either:

1. **Subagent-Driven (recommended):** a fresh worker per task, followed by review before the next task.
2. **Inline Execution:** execute tasks in this session in order, preserving the test and commit gates listed above.

No production push occurs until the user explicitly approves the final staged release.
