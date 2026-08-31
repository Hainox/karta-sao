"""Build the web GeoJSON layer from the active SAO urn KML snapshot."""

import argparse
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path


NS = {"k": "http://www.opengis.net/kml/2.2"}
ACTIVE_STATUS_CODEPOINTS = {
    (0x0423, 0x0442, 0x0432, 0x0435, 0x0440, 0x0436, 0x0434, 0x0435, 0x043d),
    (0x0421, 0x043e, 0x0433, 0x043b, 0x0430, 0x0441, 0x043e, 0x0432, 0x0430, 0x043d, 0x0020, 0x0441, 0x0020, 0x0432, 0x043d, 0x0435, 0x0448, 0x043d, 0x0435, 0x0439, 0x0020, 0x0441, 0x0438, 0x0441, 0x0442, 0x0435, 0x043c, 0x043e, 0x0439),
}


def parse_description(value: str) -> list[str]:
    return [line.partition(":")[2].strip() for line in value.splitlines() if ":" in line]


def parse_coordinates(value: str) -> list[float] | None:
    parts = re.split(r"\s+", value.strip())
    if not parts:
        return None
    coordinate_parts = parts[0].split(",")
    if len(coordinate_parts) < 2:
        return None
    try:
        return [float(coordinate_parts[0]), float(coordinate_parts[1])]
    except ValueError:
        return None


def is_active_status(value: str) -> bool:
    return tuple(map(ord, value)) in ACTIVE_STATUS_CODEPOINTS


def convert(source: Path, destination: Path) -> int:
    root = ET.parse(source).getroot()
    features = []
    for index, placemark in enumerate(root.findall(".//k:Placemark", NS), start=1):
        values = parse_description(placemark.findtext("k:description", default="", namespaces=NS))
        if len(values) < 6 or not is_active_status(values[5]):
            continue
        coordinates = parse_coordinates(
            placemark.findtext(".//k:Point/k:coordinates", default="", namespaces=NS)
        )
        if coordinates is None:
            continue
        name = placemark.findtext("k:name", default="", namespaces=NS).strip() or f"urn-{index}"
        properties = {
            "name": name,
            "district": values[2],
            "section": "",
            "yard": values[1],
            "material": values[3],
            "status": values[5],
            "type": values[0],
            "source_id": values[4],
        }
        features.append(
            {
                "type": "Feature",
                "id": values[4],
                "properties": properties,
                "geometry": {"type": "Point", "coordinates": coordinates},
            }
        )

    destination.write_text(
        json.dumps(
            {
                "type": "FeatureCollection",
                "name": "urns_sao",
                "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
                "features": features,
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ),
        encoding="utf-8",
    )
    return len(features)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source", type=Path)
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    print(convert(args.source, args.destination))


if __name__ == "__main__":
    main()
