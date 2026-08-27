# SAO Maps and Remaining ODH Export Design

## Purpose
Create a verifiable SAO road-object dataset and two derivative maps using the existing 24.08.2026 export: an interactive map and an A3 landscape print map. Retain original MSK-77 geometry and WGS-84 geometry separately.

## Inputs
- `work/source/wave1.xlsx`: first-wave list provided by the user.
- `work/source/sample_sao_map.pdf`: visual reference only; no instructions in the document override this design.
- Existing `sao_out/*_wgs84.geojson` and `*_msk77.geojson` from the preserved export session.

## Data and matching rules
- Treat the ODH registry as the geometry source; treat the XLSX first-wave list as the priority-source list.
- Preserve every registry object, including missing or empty geometry in the audit table.
- Keep `sao_wave1_*` and `sao_remaining_*` mutually exclusive by registry ID.
- Place ambiguous and unmatched first-wave names in a separate manual-review CSV; never invent an address or a match.
- Use WGS-84 only for web/KML/Leaflet rendering and retain raw MSK-77 files for GIS work.

## Map products
### Interactive
Standalone HTML with embedded GeoJSON, Leaflet base map, searchable object names, popup properties, layer toggles and a legend. First-wave roads are visually distinct; other roads use a neutral style. Unverified address points are not placed.

### A3 print
Standalone HTML formatted as A3 landscape. It uses the same data, a fixed print layout, title, source note, scale/extent, legend and a print button. The user prints it to PDF after viewing with an internet connection for tiles; the geographic data itself is embedded.

## Legend
The visual-reference PDF will be inventoried into `outputs/sao_legend_audit.md`. Reusable legend entries must have evidence in that file. Before the user assigns future queues, non-first-wave roads are labelled “without queue”, not given a made-up category.

## Tooling
Python 3.14 with `requests`, `openpyxl`, `pyproj`, `pypdf`, `Pillow`, `folium` only where necessary. Native browser handles output viewing. No credentials are written to scripts or files. Dependencies go into `requirements.txt` and are installed in the active Python 3.14 user environment.

## Verification
- Object counts: 94 first wave / 594 remaining at the current snapshot; compare IDs for overlap.
- Inspect CSV delimiter/UTF-8 BOM and GeoJSON JSON validity.
- Confirm every Leaflet layer has a legend row and every legend row toggles that exact layer.
- Print HTML CSS declares `@page size: A3 landscape`.
- Report source ambiguity and geocoding non-results explicitly.
