#!/usr/bin/env python3
"""Create the map layer only for state healthcare sites with an official source.

The wider OSM-based candidate list remains separate.  A map-search URL is a
convenience link, not evidence that a provider's card has been manually
checked, so it is deliberately not used as a confirmation criterion here.
"""
from __future__ import annotations

import argparse
import csv
import json
import time
from pathlib import Path
from urllib.parse import quote

import requests


FIELDS = [
    "name", "address", "facility_type", "ownership", "verification_status",
    "latitude", "longitude", "official_source", "official_evidence",
    "yandex_maps_search", "2gis_search", "google_maps_search", "note",
]

# Each address below is published by the organisation itself or by mos.ru.
SITES = (
    ("ГБУЗ «Городская поликлиника № 45 ДЗМ»", "Москва, 5-й Войковский проезд, 12", "взрослая поликлиника", "https://gp45msk.ru/content/info", "Официальная страница контактов: головное учреждение."),
    ("ГБУЗ «Городская поликлиника № 45 ДЗМ», филиал", "Москва, Пулковская улица, 8, строение 1", "взрослая поликлиника", "https://gp45msk.ru/content/info", "Официальная страница контактов: филиал."),
    ("ГБУЗ «Городская поликлиника № 45 ДЗМ», филиал", "Москва, Флотская улица, 9, строение 1", "взрослая поликлиника", "https://gp45msk.ru/content/info", "Официальная страница контактов: филиал."),
    ("ГБУЗ «Городская поликлиника № 45 ДЗМ», филиал", "Москва, Синявинская улица, 1Б", "взрослая поликлиника", "https://gp45msk.ru/content/info", "Официальная страница контактов: филиал в Молжаниновском районе."),
    ("ГБУЗ «Городская поликлиника № 45 ДЗМ», филиал", "Москва, 1-я Радиаторская улица, 5", "взрослая поликлиника", "https://gp45msk.ru/content/info", "Официальная страница контактов: филиал."),
    ("ГБУЗ «Городская поликлиника № 6 ДЗМ»", "Москва, улица Вучетича, 7Б", "взрослая поликлиника", "https://gp6.moscow/m/contacts/", "Официальная страница контактов: головное учреждение."),
    ("ГБУЗ «ГКБ им. С. П. Боткина ДЗМ»", "Москва, 2-й Боткинский проезд, 5", "городская клиническая больница", "https://botkinmoscow.ru/contacts/", "Официальная страница контактов больницы ДЗМ."),
    ("ГБУЗ «Детская городская поликлиника № 39 ДЗМ»", "Москва, проезд Берёзовой Рощи, 2", "детская поликлиника / травматологический пункт", "https://www.dgp86.ru/poliklinika/travmpunkt/", "Официальная страница ДГП № 86 перечисляет детский травмпункт ДГП № 39 по этому адресу."),
    ("ГБУЗ «Детская городская поликлиника № 86 ДЗМ»", "Москва, Коровинское шоссе, 36А", "детская поликлиника / травматологический пункт", "https://www.dgp86.ru/poliklinika/travmpunkt/", "Официальная страница ДГП № 86: адрес травматологического пункта."),
    ("ГБУЗ «Городская поликлиника № 45 ДЗМ», филиал", "Москва, Петрозаводская улица, 26", "взрослая поликлиника", "https://gp45msk.ru/content/info", "Официальная страница контактов: филиал."),
)

# Cached results are retained to make the build reproducible and to avoid
# repeated queries to the public Nominatim service.  They are location points,
# not surveyed entrances or parcel boundaries.
SEED_COORDINATES = {
    "Москва, 5-й Войковский проезд, 12": [55.8179022, 37.4881479],
    "Москва, Пулковская улица, 8, строение 1": [55.8450761, 37.4886374],
    "Москва, Флотская улица, 9, строение 1": [55.8541982, 37.5001724],
    "Москва, Синявинская улица, 1Б": [55.9467220, 37.3520252],
    "Москва, 1-я Радиаторская улица, 5": [55.8183615, 37.4949108],
    "Москва, улица Вучетича, 7Б": [55.8075747, 37.5567689],
    "Москва, 2-й Боткинский проезд, 5": [55.7814819, 37.5495726],
    "Москва, проезд Берёзовой Рощи, 2": [55.7853805, 37.5206101],
    "Москва, Коровинское шоссе, 36А": [55.8874510, 37.5182424],
    "Москва, Петрозаводская улица, 26": [55.8680177, 37.4922770],
}


def search_links(name: str, address: str) -> dict[str, str]:
    query = quote(f"{name}, {address}")
    return {
        "yandex_maps_search": f"https://yandex.ru/maps/?text={query}",
        "2gis_search": f"https://2gis.ru/moscow/search/{query}",
        "google_maps_search": f"https://www.google.com/maps/search/?api=1&query={query}",
    }


def geocode(address: str, cache: dict[str, list[float]]) -> list[float]:
    if address in cache:
        return cache[address]
    response = requests.get(
        "https://nominatim.openstreetmap.org/search",
        params={"q": address, "format": "jsonv2", "limit": 1, "countrycodes": "ru"},
        headers={"User-Agent": "SAO-healthcare-map/1.0 (local research)"},
        timeout=30,
    )
    response.raise_for_status()
    found = response.json()
    if not found:
        raise RuntimeError(f"Не удалось геокодировать адрес: {address}")
    coords = [float(found[0]["lat"]), float(found[0]["lon"])]
    cache[address] = coords
    time.sleep(1.1)  # Nominatim public-service usage policy
    return coords


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    try:
        cache = json.loads(args.cache.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        cache = {}
    cache = {**SEED_COORDINATES, **cache}
    rows = []
    for name, address, facility_type, official_source, evidence in SITES:
        latitude, longitude = geocode(address, cache)
        rows.append({
            "name": name, "address": address, "facility_type": facility_type,
            "ownership": "государственное учреждение здравоохранения города Москвы (ДЗМ)",
            "verification_status": "подтверждено официальным сайтом; координата геокодирована",
            "latitude": latitude, "longitude": longitude,
            "official_source": official_source, "official_evidence": evidence,
            **search_links(name, address),
            "note": "Ссылки агрегаторов — поисковые ссылки для сверки карточки; не являются самостоятельным доказательством статуса.",
        })
    args.cache.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    csv_path = args.output_dir / "sao_state_healthcare_confirmed.csv"
    with csv_path.open("w", encoding="utf-8-sig", newline="") as fh:
        writer = csv.DictWriter(fh, fieldnames=FIELDS, delimiter=";")
        writer.writeheader(); writer.writerows(rows)
    features = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [r["longitude"], r["latitude"]]}, "properties": r} for r in rows]
    geojson = {"type": "FeatureCollection", "metadata": {"record_count": len(rows), "scope": "Подтвержденные официальными источниками государственные учреждения здравоохранения САО", "coordinate_system": "WGS84 / EPSG:4326", "verification_rule": "Официальный источник подтвердил адрес и принадлежность; координаты геокодированы. Кандидаты без такой сверки не включены."}, "features": features}
    (args.output_dir / "sao_state_healthcare_confirmed_wgs84.geojson").write_text(json.dumps(geojson, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Подтверждено и подготовлено для карты: {len(rows)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
