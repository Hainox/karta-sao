# -*- coding: utf-8 -*-
"""Собирает человекочитаемый реестр точек/слотов оцифровки дворовых дорожек САО.

Вход: yard-path-points.json (опубликованный каталог фотослужбы).
Выход:
  yard-paths-registry-20261117.xlsx
    - «Свод по районам» — точек и слотов по 16 районам;
    - «Точки» — одна строка на точку (6 563);
    - «Фотослоты» — одна строка на слот (16 572).
  yard-paths-registry-20261117.csv — плоский CSV по слотам (16 572 строки).
"""
import csv
import json
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.utils import get_column_letter

CATALOG = Path(__file__).with_name("yard-path-points.json")
OUT_XLSX = Path(__file__).with_name("yard-paths-registry-20261117.xlsx")
OUT_CSV = Path(__file__).with_name("yard-paths-registry-20261117.csv")

MAP_URL = "https://hainox.github.io/karta-sao/districts/{slug}.html"


def slug_for(district):
    mapping = {
        "Аэропорт": "aeroport",
        "Беговой": "begovoy",
        "Бескудниковский": "beskudnikovsky",
        "Войковский": "voykovsky",
        "Восточное Дегунино": "vostochnoe-degunino",
        "Головинский": "golovinsky",
        "Дмитровский": "dmitrovsky",
        "Западное Дегунино": "zapadnoe-degunino",
        "Коптево": "koptevo",
        "Левобережный": "levoberezhny",
        "Молжаниновский": "molzhaninovsky",
        "Савеловский": "savelovsky",
        "Сокол": "sokol",
        "Тимирязевский": "timiryazevsky",
        "Ховрино": "khovrino",
        "Хорошевский": "khoroshevsky",
    }
    return mapping.get(district, district.lower().replace(" ", "-"))


def main():
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    points = catalog["points"]
    assert len(points) == 6563, len(points)
    total_slots = sum(len(p["slots"]) for p in points)
    assert total_slots == 16572, total_slots

    header_fill = PatternFill("solid", fgColor="FF183C35")
    header_font = Font(bold=True, color="FFFFFFFF")
    center = Alignment(horizontal="center", vertical="center")

    wb = Workbook()

    # ---- Лист «Свод по районам» ----
    ws = wb.active
    ws.title = "Свод по районам"
    ws.append(["Район", "Точек", "Фотослотов"])
    by_district = {}
    for p in points:
        d = by_district.setdefault(p["district"], [0, 0])
        d[0] += 1
        d[1] += len(p["slots"])
    for district in sorted(by_district, key=lambda x: by_district[x][1], reverse=True):
        ws.append([district, by_district[district][0], by_district[district][1]])
    ws.append(["Итого по САО", len(points), total_slots])
    for cell in ws[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center
    ws.column_dimensions["A"].width = 26
    ws.column_dimensions["B"].width = 10
    ws.column_dimensions["C"].width = 12
    ws.freeze_panes = "A2"

    # ---- Лист «Точки» ----
    ws2 = wb.create_sheet("Точки")
    point_headers = ["ID", "Район", "Привязка к дорожке (sourceId)", "Задание (sourcePiece)",
                     "Долгота", "Широта", "Слотов", "Направления (азимуты, °)",
                     "Маршрут (routeId)", "Сеть (networkId)", "Правило", "Пометка проверки", "На карте"]
    ws2.append(point_headers)
    for p in points:
        az = "; ".join(f"{s['azimuth']:g}" for s in p["slots"])
        ws2.append([p["id"], p["district"], p["sourceId"], p["sourcePiece"],
                    p["coordinates"][0], p["coordinates"][1], len(p["slots"]), az,
                    p["routeId"], p["networkId"], p["rule"], p["review"],
                    MAP_URL.format(slug=slug_for(p["district"]))])
    for col, width in enumerate([12, 24, 20, 22, 12, 12, 8, 30, 18, 16, 16, 46, 60], start=1):
        ws2.column_dimensions[get_column_letter(col)].width = width
    for cell in ws2[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center
    for row in ws2.iter_rows(min_row=2, min_col=5, max_col=6):
        for cell in row:
            cell.number_format = "0.000000"
    ws2.freeze_panes = "A2"
    ws2.auto_filter.ref = f"A1:M{ws2.max_row}"

    # ---- Лист «Фотослоты» ----
    ws3 = wb.create_sheet("Фотослоты")
    slot_headers = ["Слот", "Точка", "Район", "Кадр", "Азимут, °",
                    "Долгота", "Широта", "Статус", "На карте"]
    ws3.append(slot_headers)
    for p in points:
        for i, s in enumerate(p["slots"], start=1):
            ws3.append([s["id"], p["id"], p["district"], i, s["azimuth"],
                        p["coordinates"][0], p["coordinates"][1], "Нет фото",
                        MAP_URL.format(slug=slug_for(p["district"]))])
    for col, width in enumerate([16, 12, 24, 7, 11, 12, 12, 10, 60], start=1):
        ws3.column_dimensions[get_column_letter(col)].width = width
    for cell in ws3[1]:
        cell.fill = header_fill
        cell.font = header_font
        cell.alignment = center
    for row in ws3.iter_rows(min_row=2, min_col=6, max_col=7):
        for cell in row:
            cell.number_format = "0.000000"
    ws3.freeze_panes = "A2"
    ws3.auto_filter.ref = f"A1:I{ws3.max_row}"

    wb.save(OUT_XLSX)
    print("saved:", OUT_XLSX, OUT_XLSX.stat().st_size, "bytes")

    # ---- CSV по слотам ----
    with OUT_CSV.open("w", newline="", encoding="utf-8-sig") as fh:
        writer = csv.writer(fh)
        writer.writerow(slot_headers)
        for p in points:
            for i, s in enumerate(p["slots"], start=1):
                writer.writerow([s["id"], p["id"], p["district"], i, s["azimuth"],
                                 p["coordinates"][0], p["coordinates"][1], "Нет фото",
                                 MAP_URL.format(slug=slug_for(p["district"]))])
    print("saved:", OUT_CSV, OUT_CSV.stat().st_size, "bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())