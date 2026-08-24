#!/usr/bin/env python3
"""Build the small, externally layered GitHub Pages bundle for the ODH map."""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

try:
    from scripts.build_sao_maps import SPECS, render_html
except ModuleNotFoundError:  # Supports ``py scripts/publish_odh_pages.py``.
    from build_sao_maps import SPECS, render_html


SHELLS = (
    ("sao_map_interactive.html", "index.html", "interactive"),
    ("sao_map_print_a3.html", "print-a3.html", "print"),
)
# The boundary is the only minimum layer for a useful public map.  Other SPECS
# are copied when present so partial, verified exports (such as boundary/wave1)
# remain publishable.  The CLI enables full validation for release builds.
REQUIRED_DEFAULT_KEYS = frozenset({"boundary"})


def _write_shell(source_dir: Path, destination: Path, source_name: str, mode: str) -> None:
    """Copy an already generated shell, or create a shell for a partial export."""
    source = source_dir / source_name
    if source.is_file():
        shutil.copyfile(source, destination)
    else:
        destination.write_text(render_html([], mode=mode), encoding="utf-8")


def build_publish_bundle(
    source_dir: Path, destination: Path, *, validate_all_layers: bool = False
) -> list[Path]:
    """Write HTML shells, an external-layer manifest, and available ODH layers.

    Partial sources copy every available layer from ``SPECS`` without requiring
    optional sources.  Release callers can require the complete expected set by
    setting ``validate_all_layers``.
    """
    source_dir = Path(source_dir)
    destination = Path(destination)
    expected = SPECS if validate_all_layers else tuple(
        spec for spec in SPECS if spec.key in REQUIRED_DEFAULT_KEYS
    )
    for spec in expected:
        source = source_dir / spec.filename
        if not source.is_file():
            raise FileNotFoundError(f"Required ODH layer is missing: {source}")

    destination.mkdir(parents=True, exist_ok=True)
    layers_dir = destination / "layers"
    layers_dir.mkdir(exist_ok=True)

    created: list[Path] = []
    for source_name, destination_name, mode in SHELLS:
        shell = destination / destination_name
        _write_shell(source_dir, shell, source_name, mode)
        created.append(shell)

    manifest_layers: list[dict[str, object]] = []
    for spec in SPECS:
        source = source_dir / spec.filename
        if not source.is_file():
            continue
        target = layers_dir / spec.filename
        shutil.copyfile(source, target)
        created.append(target)
        manifest_layers.append(
            {
                "key": spec.key,
                "name": spec.name,
                "color": spec.color,
                "default": spec.default,
                "url": f"layers/{spec.filename}",
            }
        )

    manifest = destination / "layers.json"
    manifest.write_text(
        json.dumps({"layers": manifest_layers}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    created.insert(2, manifest)
    return created


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-dir", type=Path, required=True)
    parser.add_argument("--destination-dir", type=Path, required=True)
    args = parser.parse_args()
    created = build_publish_bundle(
        args.source_dir, args.destination_dir, validate_all_layers=True
    )
    print(f"Создано файлов: {len(created)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
