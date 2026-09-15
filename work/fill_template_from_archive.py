"""Заполняет шаблон ГБУ «МАЦ» августовской фотофиксацией САО.

Источник — указатель архива (район, №, категория, адрес, нарушение, файл).
Строки раскладываются по листам-районам шаблона, фото встают в колонку C,
оба блока листа «Сводка» пересчитываются по новым данным.

Шаблон не перезаписывается: результат пишется в отдельный файл.
"""

import argparse
import io
from collections import OrderedDict
from pathlib import Path

import openpyxl
from openpyxl.drawing.image import Image as XLImage
from openpyxl.drawing.spreadsheet_drawing import AnchorMarker, OneCellAnchor
from openpyxl.drawing.xdr import XDRPositiveSize2D
from openpyxl.utils import get_column_letter
from openpyxl.utils.units import pixels_to_EMU
from PIL import Image

MAX_PHOTO_WIDTH = 376
MAX_PHOTO_HEIGHT = 292
ROW_HEIGHT = 230.25
EMU_PER_PIXEL = 9525
MONTH_ROW = 2
FIRST_DATA_ROW = 2
COLUMNS_TO_CLEAR = 26


def parse_args():
    parser = argparse.ArgumentParser(description="Заполнить шаблон МАЦ августовским архивом")
    parser.add_argument("--template", required=True, help="файл шаблона")
    parser.add_argument("--index", required=True, help="указатель архива (.xlsx)")
    parser.add_argument("--photos", required=True, help="корень папок с фото по районам")
    parser.add_argument("--out", required=True, help="куда сохранить результат")
    parser.add_argument("--месяц", default="Август", help="значение колонки «Месяц»")
    parser.add_argument("--cap", type=int, default=640, help="максимальная сторона фото, точек")
    parser.add_argument("--качество", type=int, default=65, help="качество JPEG")
    return parser.parse_args()


def read_index(path):
    book = openpyxl.load_workbook(path, read_only=True)
    sheet = book[book.sheetnames[0]]
    rows = list(sheet.iter_rows(values_only=True))
    header = [str(value).strip() if value is not None else "" for value in rows[0]]
    columns = {name: header.index(name) for name in ("Район", "Категория", "Адрес", "Нарушение", "Файл")}
    records = OrderedDict()
    for row in rows[1:]:
        if not row or row[columns["Район"]] is None:
            continue
        record = {key: (row[index] if row[index] is not None else "") for key, index in columns.items()}
        records.setdefault(str(record["Район"]).strip(), []).append(record)
    book.close()
    return records


def shrink(source, cap, quality):
    with Image.open(source) as image:
        image = image.convert("RGB")
        image.thumbnail((cap, cap), Image.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=quality, optimize=True, progressive=True)
        return buffer.getvalue(), image.width, image.height


def make_image(payload, width, height):
    image = XLImage(io.BytesIO(payload))
    image.width = width
    image.height = height
    return image


def anchor_to(image, row, column):
    offset = pixels_to_EMU(2)
    marker = AnchorMarker(col=column - 1, colOff=offset, row=row - 1, rowOff=offset)
    image.anchor = OneCellAnchor(
        _from=marker,
        ext=XDRPositiveSize2D(pixels_to_EMU(image.width), pixels_to_EMU(image.height)),
    )


def clear_sheet(sheet):
    sheet._images = []
    for row in sheet.iter_rows(min_row=FIRST_DATA_ROW, max_row=sheet.max_row, max_col=COLUMNS_TO_CLEAR):
        for cell in row:
            if cell.value is not None:
                cell.value = None


def row_formulas(sheet):
    formulas = {}
    for column in range(8, COLUMNS_TO_CLEAR + 1):
        value = sheet.cell(FIRST_DATA_ROW, column).value
        if isinstance(value, str) and value.startswith("="):
            letter = get_column_letter(column)
            formulas[column] = (letter, value.replace(f"{letter}{FIRST_DATA_ROW}", f"{letter}{{row}}"))
    return formulas


def fill_district(sheet, name, records, month, photos_root, cache, cap, quality):
    formulas = row_formulas(sheet)
    clear_sheet(sheet)
    missing = []
    for offset, record in enumerate(records):
        row = FIRST_DATA_ROW + offset
        sheet.cell(row, 1).value = month
        sheet.cell(row, 2).value = name
        sheet.cell(row, 5).value = f"Адрес: {record['Адрес']} Нарушение: {record['Нарушение']}"
        sheet.cell(row, 6).value = record["Категория"]
        sheet.row_dimensions[row].height = ROW_HEIGHT
        for column, (letter, template) in formulas.items():
            sheet.cell(row, column).value = template.format(row=row)

        source = photos_root / name / str(record["Файл"])
        if not source.exists():
            missing.append(record["Файл"])
            continue
        try:
            entry = cache.get(record["Файл"])
            if entry is None:
                payload, width, height = shrink(source, cap, quality)
                scale = min(MAX_PHOTO_WIDTH / width, MAX_PHOTO_HEIGHT / height, 1.0)
                entry = (payload, max(1, round(width * scale)), max(1, round(height * scale)))
                cache[record["Файл"]] = entry
            payload, width, height = entry
            image = make_image(payload, width, height)
            anchor_to(image, row, 3)
            sheet.add_image(image)
        except Exception as error:  # noqa: BLE001 — одна битая фотография не должна ронять сборку
            missing.append(f"{record['Файл']} ({error})")
    return missing


def district_totals(records):
    totals = {"ДТ": 0, "МКД": 0, "ОДХ": 0, "ОО": 0}
    for record in records:
        key = str(record["Категория"]).strip().upper()
        if key in totals:
            totals[key] += 1
    totals["всего"] = len(records)
    return totals


def write_summary_row(sheet, row, totals, wide):
    sheet.cell(row, 4).value = totals["всего"]
    sheet.cell(row, 5).value = totals["ДТ"]
    sheet.cell(row, 7).value = totals["МКД"]
    sheet.cell(row, 9).value = totals["ОДХ"]
    sheet.cell(row, 11).value = totals["ОО"]
    if wide:
        sheet.cell(row, 15).value = 0
    else:
        sheet.cell(row, 13).value = 0
        sheet.cell(row, 14).value = 0
        sheet.cell(row, 15).value = 0
    sheet.cell(row, 16).value = totals["всего"]


def update_summary(sheet, by_district, blocks):
    totals_by_district = {name: district_totals(records) for name, records in by_district.items()}
    updated = 0
    for first, last, wide in blocks:
        for row in range(first, last + 1):
            name = sheet.cell(row, 3).value
            if name is None:
                continue
            totals = totals_by_district.get(str(name).strip())
            if totals is None:
                continue
            write_summary_row(sheet, row, totals, wide)
            updated += 1
    grand = district_totals([record for records in by_district.values() for record in records])
    for row in (22, 45):
        write_summary_row(sheet, row, grand, wide=(row == 22))
    return updated, grand


def replace_month(sheet):
    title = sheet.cell(1, 1).value
    if isinstance(title, str) and "ИЮЛЬ" in title.upper():
        sheet.cell(1, 1).value = title.replace("ИЮЛЬ", "АВГУСТ").replace("Июль", "Август")


def main():
    args = parse_args()
    out_path = Path(args.out)
    photos_root = Path(args.photos)
    by_district = read_index(args.index)

    book = openpyxl.load_workbook(args.template)
    cache = {}
    missing = {}
    placed = 0

    for name, records in by_district.items():
        if name not in book.sheetnames:
            missing.setdefault("нет листа", []).append(name)
            continue
        broken = fill_district(book[name], name, records, args.месяц, photos_root, cache, args.cap, args.качество)
        if broken:
            missing[name] = broken
        placed += len(records)
        print(f"{name:<22} нарушений {len(records):>4}, фото {len(records) - len(broken):>4}")

    summary = book["Сводка"]
    replace_month(summary)
    updated, grand = update_summary(summary, by_district, blocks=[(5, 21, True), (27, 44, False)])
    print(f"\nсводка: заполнено строк {updated} в двух блоках")
    print(f"итого: {grand['всего']} нарушений — ДТ {grand['ДТ']}, МКД {grand['МКД']}, ОДХ {grand['ОДХ']}, ОО {grand['ОО']}")

    book.save(out_path)
    size = out_path.stat().st_size / 1024 / 1024
    print(f"\nфотографий вставлено: {placed}")
    print(f"файл: {out_path} ({size:.0f} МБ)")
    if missing:
        print("\nне найдено:")
        for name, files in missing.items():
            print(f"  {name}: {len(files)} — {files[:3]}")


if __name__ == "__main__":
    main()
