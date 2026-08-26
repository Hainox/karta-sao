#!/usr/bin/env python3
"""Apply the fixed 97-position first-queue list to the ODH export."""
from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


def load_ids(path: Path) -> set[str]:
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return {row["id"].strip() for row in csv.DictReader(handle) if row.get("id", "").strip()}


EXCLUDED_PUBLIC_IDS = {"marker-wave1-53"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queue-file", type=Path, required=True)
    parser.add_argument("--fixed-list", type=Path, required=True)
    args = parser.parse_args()

    fixed_ids = load_ids(args.fixed_list)
    if len(fixed_ids) != 97:
        raise ValueError(f"The fixed first-queue list must contain exactly 97 IDs, got {len(fixed_ids)}")

    data = json.loads(args.queue_file.read_text(encoding="utf-8"))
    features = [
        feature for feature in data.get("features", [])
        if str(feature.get("properties", {}).get("id", "")).strip() in fixed_ids
    ]
    present_ids = {str(feature.get("properties", {}).get("id", "")).strip() for feature in features}
    missing = fixed_ids - present_ids
    unexpected_missing = missing - EXCLUDED_PUBLIC_IDS
    if unexpected_missing:
        raise ValueError("Fixed first-queue objects missing from source export: " + ", ".join(sorted(unexpected_missing)))

    # Preserve the original first-queue metadata.  The 56 cascade references
    # are removed solely by ID, not relabelled as new first-queue positions.
    data["features"] = features
    args.queue_file.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"First queue fixed: {len(present_ids)} objects, {len(features)} geometries")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
