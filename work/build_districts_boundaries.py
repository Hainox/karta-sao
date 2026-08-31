"""Собирает districts.geojson - границы 16 муниципальных округов САО.

Источник: http://gis-lab.info/data/mos-adm/mo.geojson (муниципальные
образования Москвы; границы: © участники OpenStreetMap, ODbL; ссылка на
GIS-Lab обязательна). Скачивание пробует https://, при неудаче - http://.

Из источника берутся все объекты с ABBREV_AO == "САО" (ожидается ровно 16),
названия нормализуются: "ё" -> "е" (в источнике "Савёловский"/"Хорошёвский",
в проекте - "Савеловский"/"Хорошевский").

Из areas.geojson (2294 двора, свойство district) считаются количества дворов
по округам; набор уникальных значений district обязан в точности совпасть
с 16 нормализованными названиями (иначе - abort с перечнем расхождений).

Выход: districts.geojson в корне репозитория - FeatureCollection из 16
объектов (геометрия без изменений) со свойствами {district, name, OKATO,
OKTMO, yards_count} и top-level foreign member "metadata".

Запуск: python work/build_districts_boundaries.py
"""

import argparse
import datetime
import json
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC_URLS = (
    "https://gis-lab.info/data/mos-adm/mo.geojson",
    "http://gis-lab.info/data/mos-adm/mo.geojson",
)
SOURCE_CACHE = ROOT / "work" / "mo_source.geojson"
AREAS_PATH = ROOT / "areas.geojson"
OUT_PATH = ROOT / "districts.geojson"

SOURCE_LABEL = (
    "gis-lab.info/data/mos-adm (муниципальные образования); "
    "границы: © участники OpenStreetMap, ODbL; ссылка на GIS-Lab обязательна"
)
GENERATOR = "work/build_districts_boundaries.py"
TOTAL_YARDS = 2294

UA = "Mozilla/5.0 (compatible; karta-sao-build/1.0)"


def download_source(cache_path):
    """Скачивает источник (https, затем http). Возвращает путь к файлу."""
    if cache_path.exists():
        print(f"Использую кэш источника: {cache_path}")
        return cache_path
    last_error = None
    for url in SRC_URLS:
        try:
            request = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(request, timeout=180) as response:
                body = response.read()
            cache_path.write_bytes(body)
            print(f"Скачано ({response.geturl()}): {len(body)} байт")
            return cache_path
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as exc:
            last_error = exc
            print(f"Не удалось скачать {url}: {exc}")
    raise SystemExit(f"Не удалось скачать источник ни по одному из URL: {SRC_URLS} ({last_error})")


def load_sao_features(source_path):
    """Возвращает список (name, okato, oktmo, geometry) для ABBREV_AO == САО."""
    with open(source_path, encoding="utf-8") as fh:
        data = json.load(fh)
    features = data.get("features", [])
    sao = [f for f in features if f.get("properties", {}).get("ABBREV_AO") == "САО"]
    if len(sao) != 16:
        names = sorted(f["properties"].get("NAME", "") for f in sao)
        raise SystemExit(
            f"Ожидалось ровно 16 объектов САО, найдено {len(sao)}: {names}"
        )
    rows = []
    for feature in sao:
        props = feature["properties"]
        name = props["NAME"].replace("ё", "е").replace("Ё", "Е")
        rows.append(
            {
                "name": name,
                "okato": props.get("OKATO"),
                "oktmo": props.get("OKTMO"),
                "geometry": feature["geometry"],
            }
        )
    names = [r["name"] for r in rows]
    if len(set(names)) != len(names):
        raise SystemExit(f"Названия САО после нормализации не уникальны: {names}")
    return rows


def yard_counts(areas_path):
    """Считает дворы по округам из areas.geojson."""
    with open(areas_path, encoding="utf-8") as fh:
        data = json.load(fh)
    counter = Counter(
        f["properties"].get("district") for f in data.get("features", [])
    )
    if None in counter:
        raise SystemExit("В areas.geojson есть объекты без свойства district")
    if sum(counter.values()) != len(data.get("features", [])):
        raise SystemExit("Подсчёт дворов не сходится с числом объектов areas.geojson")
    return counter


def build(areas_path, source_urls, out_path, cache_path):
    source_path = download_source(cache_path)
    rows = load_sao_features(source_path)
    counts = yard_counts(areas_path)

    source_names = {r["name"] for r in rows}
    area_names = set(counts)
    if source_names != area_names:
        only_source = sorted(source_names - area_names)
        only_areas = sorted(area_names - source_names)
        raise SystemExit(
            "Наборы названий округов не совпадают:\n"
            f"  только в источнике: {only_source}\n"
            f"  только в areas.geojson: {only_areas}"
        )

    total = sum(counts.values())
    if total != TOTAL_YARDS:
        raise SystemExit(f"Всего дворов {total}, ожидалось {TOTAL_YARDS}")

    rows.sort(key=lambda r: r["name"])
    features = []
    for row in rows:
        features.append(
            {
                "type": "Feature",
                "properties": {
                    "district": row["name"],
                    "name": row["name"],
                    "OKATO": row["okato"],
                    "OKTMO": row["oktmo"],
                    "yards_count": counts[row["name"]],
                },
                "geometry": row["geometry"],
            }
        )

    geojson = {
        "type": "FeatureCollection",
        "features": features,
        "metadata": {
            "source": SOURCE_LABEL,
            "generated": datetime.date.today().isoformat(),
            "generator": GENERATOR,
        },
    }

    with open(out_path, "w", encoding="utf-8") as fh:
        json.dump(geojson, fh, ensure_ascii=False, separators=(",", ":"))
        fh.write("\n")

    size = out_path.stat().st_size
    print("\nОкруга САО (16) и дворы в каждом:")
    for row in rows:
        print(f"  {row['name']}: {counts[row['name']]}")
    print(f"Всего дворов: {total}")
    print(f"Записано: {out_path} ({size} байт)")


def main(argv=None):
    parser = argparse.ArgumentParser(description="Сборка границ округов САО")
    parser.add_argument("--out", default=str(OUT_PATH))
    parser.add_argument("--areas", default=str(AREAS_PATH))
    parser.add_argument("--cache", default=str(SOURCE_CACHE))
    args = parser.parse_args(argv)
    build(args.areas, SRC_URLS, Path(args.out), Path(args.cache))


if __name__ == "__main__":
    main()