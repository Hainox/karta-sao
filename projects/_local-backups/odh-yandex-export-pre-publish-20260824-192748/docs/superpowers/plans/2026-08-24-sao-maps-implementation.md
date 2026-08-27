# SAO Maps and Remaining ODH Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce verified remaining-ODH exports, legend evidence, and interactive plus A3 map products for SAO.

**Architecture:** The export layer creates raw MSK-77 and transformed WGS-84 GeoJSON/CSV plus a matching audit. The map layer consumes WGS-84 GeoJSON, embeds it in standalone Leaflet HTML, and uses a single metadata table to generate both map legends. The reference PDF is treated as evidence for legend wording and symbols only.

**Tech Stack:** Python 3.14, requests, openpyxl, pyproj, pypdf, standard-library HTML generation, Leaflet 1.9.4.

**Spec:** `docs/superpowers/specs/2026-08-24-sao-maps-design.md`

## Global Constraints

- Never place credentials in code, logs, deliverables, or caches.
- Use MSK-77 for raw GIS outputs and WGS-84 for Leaflet/KML.
- Keep uncertain name/address matches out of the confirmed map layers.
- Write user-facing outputs only beneath `outputs/`.
- Use UTF-8 for HTML/GeoJSON and UTF-8 with BOM with semicolon delimiter for CSV.

---

### Task 1: Establish a reproducible workspace and dependency manifest

**Files:**
- Create: `requirements.txt`
- Create: `tests/test_environment.py`

**Interfaces:**
- Produces a documented Python dependency set used by subsequent tasks.

- [ ] **Step 1: Write failing dependency-import test**

```python
import importlib
import pytest

@pytest.mark.parametrize("package", ["requests", "openpyxl", "pyproj", "pypdf"])
def test_required_package_is_importable(package):
    assert importlib.import_module(package)
```

- [ ] **Step 2: Run test to verify required imports fail where dependencies are missing**

Run: `py -3.14 -m pytest tests/test_environment.py -v`
Expected: a failure for each missing package.

- [ ] **Step 3: Add pinned-compatible requirements and install them for Python 3.14**

```text
requests>=2.32,<3
openpyxl>=3.1,<4
pyproj>=3.7,<4
pypdf>=5,<7
```

Run: `py -3.14 -m pip install --user -r requirements.txt`

- [ ] **Step 4: Run environment test**

Run: `py -3.14 -m pytest tests/test_environment.py -v`
Expected: PASS.

### Task 2: Audit the PDF legend and the first-wave name matching

**Files:**
- Create: `outputs/sao_legend_audit.md`
- Create: `outputs/sao_wave1_match_review.csv`
- Test: `tests/test_audit_outputs.py`

**Interfaces:**
- Consumes `work/source/sample_sao_map.pdf` and the previous `sverka_report.csv`.
- Produces evidence-backed legend notes and a review CSV with fields `source_name`, `registry_name`, `match_method`, `similarity`, `review_status`, `note`.

- [ ] **Step 1: Write failing structural-output tests**

```python
import csv
from pathlib import Path

def test_match_review_has_required_columns():
    with Path("outputs/sao_wave1_match_review.csv").open(encoding="utf-8-sig", newline="") as stream:
        fields = csv.DictReader(stream, delimiter=";").fieldnames
    assert fields == ["source_name", "registry_name", "match_method", "similarity", "review_status", "note"]
```

- [ ] **Step 2: Extract PDF text/page inventory and filter non-exact match rows**

Run: `py -3.14 scripts/audit_sao_reference.py --pdf work/source/sample_sao_map.pdf --match-report work/source/sverka_report.csv --output-dir outputs`
Expected: one legend audit and one seven-row review CSV.

- [ ] **Step 3: Run output tests**

Run: `py -3.14 -m pytest tests/test_audit_outputs.py -v`
Expected: PASS.

### Task 3: Create remaining-ODH export verification and a rerunnable exporter

**Files:**
- Create: `scripts/export_sao_remaining.py`
- Create: `tests/test_export_sao_remaining.py`
- Create: `outputs/sao_export_validation.json`

**Interfaces:**
- Consumes registry geometry response, optional JSON cache, first-wave registry IDs.
- Produces `sao_remaining_msk77.geojson`, `sao_remaining_wgs84.geojson`, corresponding CSVs and `sao_export_validation.json`.

- [ ] **Step 1: Write failing tests for ID partition and coordinate output selection**

```python
def test_partition_has_no_overlap():
    wave1 = {"1", "2"}
    all_ids = {"1", "2", "3"}
    assert remaining_ids(all_ids, wave1) == {"3"}
```

- [ ] **Step 2: Implement pure functions and verify them**

Run: `py -3.14 -m pytest tests/test_export_sao_remaining.py -v`
Expected: PASS.

- [ ] **Step 3: Validate the current exported snapshot without logging in**

Run: `py -3.14 scripts/export_sao_remaining.py --validate-only --data-dir work/source/sao_out --report outputs/sao_export_validation.json`
Expected: 94 wave1 IDs, 594 remaining IDs, zero overlap and valid GeoJSON.

### Task 4: Build maps and verify HTML behavior structurally

**Files:**
- Create: `scripts/build_sao_maps.py`
- Create: `tests/test_build_sao_maps.py`
- Create: `outputs/sao_map_interactive.html`
- Create: `outputs/sao_map_print_a3.html`

**Interfaces:**
- Consumes WGS-84 GeoJSON files and `LayerSpec(name, color, enabled)` metadata.
- Produces two self-contained HTML data products with common legend entries.

- [ ] **Step 1: Write failing tests for legend/layer alignment and A3 CSS**

```python
def test_print_markup_declares_a3_landscape():
    assert "@page { size: A3 landscape" in render_html([], mode="print")
```

- [ ] **Step 2: Implement map renderer with escaped popup values and local-data embedding**

Run: `py -3.14 -m pytest tests/test_build_sao_maps.py -v`
Expected: PASS.

- [ ] **Step 3: Generate map deliverables from validated snapshot**

Run: `py -3.14 scripts/build_sao_maps.py --data-dir work/source/sao_out --output-dir outputs`
Expected: interactive and A3 HTML files.

### Task 5: Deliver execution guide and final checks

**Files:**
- Create: `outputs/README_как_обновить_карту.md`
- Modify: `outputs/sao_export_validation.json`

**Interfaces:**
- Documents commands, credential environment variables, output meanings, and manual review boundaries.

- [ ] **Step 1: Write operation guide with exact PowerShell commands**
- [ ] **Step 2: Validate JSON, CSV headers, output filenames, and map HTML links**
- [ ] **Step 3: Record counts, blockers, and required manual actions in validation report**
