# AGENTS.md

## Unwritten
- Publishing: `main` is production. GitHub Pages serves the root atlas, `hub/`, `odh-map/`, `yards-print/` straight from it, so a merge is a release. `api/` and `photo-service/` deploy separately per `deploy/SAO_PHOTO_PRODUCTION_RUNBOOK.md`.
- Gotchas: Pages need a local server (`python3 -m http.server 8000`): `file://` blocks the GeoJSON fetch and the Yandex key is referer-locked to `localhost:8000`. GeoJSON order is `[lng, lat]`.
- Checks: `python -m pytest tests -q` from the root (atlas pages and published data); `npm test` in `photo-service/`; `npm run test:ui` (Playwright) in `odh-map/`. CI runs only the first two.
- Conventions: UI text, README, and `ChangeLog.md` are in Russian; each user-visible change gets a dated `ChangeLog.md` bullet. Working sources go in `projects/.../work`, finished ODH layers in `odh-map/layers/`; the root holds only published layers. The type dictionary in `odh-map/district-changes.js` drives line colours, labels, and legend at once; change types there only.
- Why: an object outside every yard stays «Без участка» in exports; it is never silently attributed to a district. `object_no` is assigned once and never renumbered, because people refer to objects by it.
- Off-limits: generated layers are rebuilt by their scripts, not edited by hand: `districts.geojson` via `work/build_districts_boundaries.py` then `work/apply_water_mask.py`. `projects/odh-yandex-export/outputs/` holds past deliverables.

## Pointers
- **Writing** or reviewing code: apply `CODING_STANDARDS.md`; project config and linters win where they disagree.
- **Security**-sensitive change (auth, permissions, untrusted input, secrets): read `docs/agents/security.md` first.
- **Committing** or opening a PR: follow `docs/agents/git.md`.
- **Risky** change (spans modules, migrates data, alters a public API): propose a phased plan and get approval before editing.
- **Done** means you ran the project's own check commands and they are green, or you named the ones you could not run.
