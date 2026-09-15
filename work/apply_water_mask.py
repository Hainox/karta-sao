"""Вырезает акватории из границ районов.

Границы муниципальных округов приходят из OSM (см.
work/build_districts_boundaries.py) и включают воду: Химкинское
водохранилище заходит внутрь Войковского, Головинского и Левобережного.
На карте фотофиксации это выглядит как граница района, проходящая по воде,
поэтому акватории вырезаются из полигонов.

Вход:  districts.geojson (границы), water.geojson (акватории, OSM/Nominatim)
Выход: districts.geojson с дырками вместо воды (геометрия Polygon/MultiPolygon)
       и свойством water_masked = true

Скрипт идемпотентен: повторный запуск на уже обработанном файле ничего не меняет.

Запуск: python work/apply_water_mask.py
"""

import json
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

ROOT = Path(__file__).resolve().parents[1]
DISTRICTS_PATH = ROOT / "districts.geojson"
WATER_PATH = ROOT / "water.geojson"

SCALE_NOTE = "площади в градусах, не в метрах"


def load(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def clean(geometry):
    """Округление до 6 знаков убирает шум разности и уменьшает файл."""
    return json.loads(json.dumps(mapping(geometry), default=str))


def main():
    districts = load(DISTRICTS_PATH)
    water = load(WATER_PATH)

    if districts.get("metadata", {}).get("water_masked") is True:
        print("Маска воды уже применена, файл не изменяется.")
        return

    mask = unary_union([shape(feature["geometry"]) for feature in water["features"]])
    changed = []
    for feature in districts["features"]:
        district = shape(feature["geometry"])
        inside = district.intersection(mask)
        if inside.is_empty or inside.area <= 0:
            continue
        result = district.difference(mask)
        feature["geometry"] = clean(result)
        changed.append((feature["properties"]["district"], inside.area, result.area))
        print(
            f"{feature['properties']['district']}: вырезано воды "
            f"{inside.area / district.area * 100:.1f}%, тип геометрии теперь {result.geom_type}"
        )

    if not changed:
        print("Пересечений с акваториями нет, файл не изменяется.")
        return

    metadata = districts.setdefault("metadata", {})
    metadata["water_masked"] = True
    metadata["water_source"] = water.get("metadata", {}).get("source")
    metadata["water_mask_applied_by"] = "work/apply_water_mask.py"
    metadata["water_mask_note"] = (
        "Границы округов из OSM включали акватории; вода вырезана, "
        "чтобы граница района не проходила по водохранилищу."
    )

    with open(DISTRICTS_PATH, "w", encoding="utf-8") as handle:
        json.dump(districts, handle, ensure_ascii=False, separators=(",", ":"))
        handle.write("\n")

    print(f"Обновлено районов: {len(changed)} ({SCALE_NOTE})")
    print(f"Записано: {DISTRICTS_PATH} ({DISTRICTS_PATH.stat().st_size} байт)")


if __name__ == "__main__":
    main()
