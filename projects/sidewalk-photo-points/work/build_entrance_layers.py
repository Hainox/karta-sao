"""Слой входных групп (подъездов МКД) для карт районов — ориентир при
расстановке точек съёмки тротуаров. Слой видит только префектура.

Источник: InJob_30_1.xlsx (лист «МКД 5.0 (в работе)»), тот же реестр, что
object-maps/data/entrances.json. Район подъезда берётся из колонки «Район».

Запуск:  python3 build_entrance_layers.py [путь к xlsx]
Результат: districts/layers/<slug>/entrances.geojson
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[3]
WORK = Path(__file__).resolve().parent
SLUGS = {
    "Аэропорт": "aeroport", "Беговой": "begovoy", "Бескудниковский": "beskudnikovskiy",
    "Войковский": "voykovskiy", "Восточное Дегунино": "vostochnoe-degunino",
    "Головинский": "golovinskiy", "Дмитровский": "dmitrovskiy",
    "Западное Дегунино": "zapadnoe-degunino", "Коптево": "koptevo",
    "Левобережный": "levoberezhnyy", "Молжаниновский": "molzhaninovskiy",
    "Савеловский": "savelovskiy", "Сокол": "sokol", "Тимирязевский": "timiryazevskiy",
    "Ховрино": "hovrino", "Хорошевский": "horoshevskiy",
}
HEADER = ("№", "Район", "УНОМ", "Адрес", "№ подъезда", "Участок", "Этажность",
          "Кол-во лифтов в каждом подъезде", "Наличие рабочей мусорокамеры", "Координаты подъездов")


def yes_no(value):
    text = str(value or "").strip().lower()
    return {"да": "есть", "нет": "нет"}.get(text, str(value or "").strip())


def build(source):
    sheet = openpyxl.load_workbook(source, read_only=True, data_only=True).worksheets[0]
    rows = list(sheet.iter_rows(values_only=True))
    header_at = next(i for i, row in enumerate(rows) if tuple(row[:10]) == HEADER)
    by_district = defaultdict(list)
    problems = []
    for excel_row, row in enumerate(rows[header_at + 3:], start=header_at + 4):
        if not any(v is not None for v in row):
            continue
        no, district, unom, address, entrance, plot, floors, lifts, chute, coords = row[:10]
        try:
            lat, lon = (float(x) for x in str(coords).split(","))
        except ValueError:
            problems.append(f"строка {excel_row}: координаты «{coords}»")
            continue
        if district not in SLUGS:
            problems.append(f"строка {excel_row}: район «{district}»")
            continue
        lifts_text = "нет" if str(lifts).strip().lower() == "нет" else str(lifts).strip()
        by_district[district].append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [round(lon, 7), round(lat, 7)]},
            "properties": {
                "district": district, "unom": unom, "address": str(address).strip(),
                "entrance": entrance, "plot": plot, "floors": floors,
                "lifts": lifts_text, "garbage_chute": yes_no(chute), "source_row": excel_row,
            },
        })
    total = 0
    for district, features in sorted(by_district.items()):
        features.sort(key=lambda f: (f["properties"]["address"], f["properties"]["entrance"]))
        out = ROOT / "districts" / "layers" / SLUGS[district] / "entrances.geojson"
        out.write_text(json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
        total += len(features)
        print(f"{district}: {len(features)}")
    print(f"Всего подъездов: {total}; с ошибками: {len(problems)}")
    for line in problems[:20]:
        print("  " + line)


if __name__ == "__main__":
    build(sys.argv[1] if len(sys.argv) > 1 else WORK / "InJob_30_1.xlsx")
