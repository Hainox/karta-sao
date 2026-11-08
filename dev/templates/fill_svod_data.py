# -*- coding: utf-8 -*-
"""Наполнение шаблона Google-таблицы живыми данными кабинета приёмки.

Вход: шаблон dev/templates/svod-dp-sp-szhkh.xlsx, CSV из базы (sheet-data-clean.csv)
и реестр «Север ЖКХ» (registry.csv) для колонок N–P.

Запуск:
    python dev/templates/fill_svod_data.py <csv> <registry.csv> <out.xlsx>

Шаблон не пересобирается: скрипт открывает его и заполняет «Реестр», «Сверка»,
«На доработке», «Журнал» и `_state`.
"""

import csv
import io
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter

ROOT = Path(__file__).resolve().parent
TEMPLATE = ROOT / "svod-dp-sp-szhkh.xlsx"
THUMB = "https://obhod-sao.ru/photo-api/object-photo-points/playgrounds/photo-thumb/"
SEVER_THUMB = "https://obhod-sao.ru/photo-api/object-photo-points/playgrounds/sever-thumb/"
MAP = "https://hainox.github.io/karta-sao/districts/"
MSK = ZoneInfo("Europe/Moscow")
KINDS = {"dp": "ДП", "sp": "СП"}
KIND_LABELS = {"dp": "Детская площадка", "sp": "Спортивная площадка"}


def parse_day(value):
    if not value:
        return None
    try:
        stamp = datetime.fromisoformat(value.replace(" ", "T"))
    except ValueError:
        return None
    if stamp.tzinfo:
        stamp = stamp.astimezone(MSK).replace(tzinfo=None)
    return stamp


def read_rows(path):
    text = path.read_text(encoding="utf-8-sig")
    rows = list(csv.DictReader(io.StringIO(text), delimiter=";"))
    for row in rows:
        row["state"] = ("rework" if not row["photo_id"] and row["rejected_at"]
                        else row["photo_state"] or "empty")
        row["uploaded"] = parse_day(row["uploaded_at"])
        row["reviewed"] = parse_day(row["reviewed_at"])
        row["rejected"] = parse_day(row["rejected_at"])
    return rows


def read_sever(path):
    """ID площадки → последняя задача и наличие снимков в выгрузке Север ЖКХ."""
    latest = {}
    text = path.read_text(encoding="utf-8-sig")
    for row in csv.DictReader(io.StringIO(text), delimiter=";"):
        oid = (row.get("ID площадки") or "").strip()
        if not oid or oid in ("11111111", "33333333"):
            continue
        day = (row.get("Дата задачи") or "").strip()
        has_file = bool((row.get("Файл") or "").strip())
        current = latest.setdefault(oid, {"date": "", "task": "", "files": 0})
        if day > current["date"]:
            current["date"] = day
            current["task"] = (row.get("ID задачи") or "").strip()
        current["files"] += 1 if has_file else 0
    return latest


def read_sever_tokens(path):
    """ID площадки → токен снимка из «Север ЖКХ»."""
    text = path.read_text(encoding="utf-8-sig")
    return {row["object_id"].strip(): row["token"].strip()
            for row in csv.DictReader(io.StringIO(text))
            if row.get("object_id") and row.get("token")}


def main():
    csv_path = Path(sys.argv[1])
    sever_path = Path(sys.argv[2])
    tokens_path = Path(sys.argv[3])
    out_path = Path(sys.argv[4])

    rows = read_rows(csv_path)
    sever = read_sever(sever_path)
    tokens = read_sever_tokens(tokens_path)
    wb = load_workbook(TEMPLATE)

    refs = wb["Справочники"]
    slugs = {refs.cell(row=r, column=3).value: refs.cell(row=r, column=5).value
             for r in range(2, 18)}

    # --- Реестр -----------------------------------------------------------
    reg = wb["Реестр"]
    for index, row in enumerate(rows):
        r = 2 + index
        reg.cell(row=r, column=1, value=row["point_id"])
        reg.cell(row=r, column=2, value=str(row["source_id"]))
        reg.cell(row=r, column=3, value=row["district"])
        reg.cell(row=r, column=4, value=KINDS.get(row["kind"], row["kind"]))
        reg.cell(row=r, column=5, value=row["address"])
        reg.cell(row=r, column=6, value=float(row["latitude"]) if row["latitude"] else None)
        reg.cell(row=r, column=7, value=float(row["longitude"]) if row["longitude"] else None)
        state = {"accepted": "Принято", "pending": "На проверке",
                 "rework": "На доработке"}.get(row["state"], "Нет фото")
        reg.cell(row=r, column=8, value=state)
        reg.cell(row=r, column=9, value=row["uploaded"])
        reg.cell(row=r, column=10, value=row["reviewed"])
        reg.cell(row=r, column=11, value=row["review_comment"] or None)
        reg.cell(row=r, column=12, value=row["photo_id"] or None)
        reg.cell(row=r, column=13, value=THUMB + row["token"] if row["token"] else None)

        found = sever.get(str(row["source_id"]).strip())
        reg.cell(row=r, column=14, value="есть" if found else "нет")
        reg.cell(row=r, column=15, value=found["task"] if found else None)
        reg.cell(row=r, column=16, value=parse_day(found["date"]) if found and found["date"] else None)
        sever_token = tokens.get(str(row["source_id"]).strip())
        reg.cell(row=r, column=17, value=SEVER_THUMB + sever_token if sever_token else None)

    # --- Сверка: срез 300 принятых, понемногу с каждого района -----------
    sv = wb["Сверка"]
    accepted = [row for row in rows if row["state"] == "accepted" and row["token"]]
    by_district = {}
    for row in sorted(accepted, key=lambda item: (
            0 if tokens.get(str(item["source_id"]).strip()) else 1,
            item["kind"], item["address"] or "")):
        by_district.setdefault(row["district"], []).append(row)
    slice_rows = []
    for offset in range(20):
        for district in sorted(by_district):
            if offset < len(by_district[district]):
                slice_rows.append(by_district[district][offset])
            if len(slice_rows) >= 300:
                break
        if len(slice_rows) >= 300:
            break
    for index, row in enumerate(slice_rows[:300]):
        r = 8 + index
        sv.cell(row=r, column=2, value=None)
        sv.cell(row=r, column=3, value=row["district"])
        sv.cell(row=r, column=4, value=row["address"])
        sv.cell(row=r, column=5, value=KIND_LABELS.get(row["kind"], row["kind"]))
        sv.cell(row=r, column=6, value=str(row["source_id"]))
        sever_token = tokens.get(str(row["source_id"]).strip())
        sv.cell(row=r, column=7, value='=IMAGE("{}",4,160,120)'.format(SEVER_THUMB + sever_token)
                if sever_token else None)
        sv.cell(row=r, column=8, value='=IMAGE("{}",4,160,120)'.format(THUMB + row["token"]))
        sv.cell(row=r, column=9, value="Принято")
        sv.cell(row=r, column=10, value="—")
        sv.cell(row=r, column=15, value=row["point_id"])
        sv.cell(row=r, column=16, value=row["photo_id"])
        sv.cell(row=r, column=17, value=None)

    sv.auto_filter.ref = "A7:N307"

    # --- На доработке -----------------------------------------------------
    rew = wb["На доработке"]
    rework = [row for row in rows if row["state"] == "rework"]
    rework.sort(key=lambda row: row["rejected"] or datetime.min, reverse=True)
    for index, row in enumerate(rework):
        r = 5 + index
        slug = slugs.get(row["district"], "")
        rew.cell(row=r, column=1, value=index + 1)
        rew.cell(row=r, column=2, value=row["district"])
        rew.cell(row=r, column=3, value=row["address"])
        rew.cell(row=r, column=4, value=str(row["source_id"]))
        rew.cell(row=r, column=5, value="На доработке")
        rew.cell(row=r, column=6, value=row["rejected_comment"] or None)
        rew.cell(row=r, column=7, value="—")
        rew.cell(row=r, column=11, value=row["rejected"])
        rew.cell(row=r, column=12, value='=HYPERLINK("{}{}.html","На карте")'.format(MAP, slug))

    # --- Журнал и состояние ----------------------------------------------
    log = wb["Журнал"]
    log.cell(row=3, column=1, value=datetime(2026, 11, 8, 0, 0))
    log.cell(row=3, column=2, value="снимок данных")
    log.cell(row=3, column=3, value=len(rows))
    log.cell(row=3, column=4, value=0)
    log.cell(row=3, column=5, value=0)
    log.cell(row=3, column=6, value="OK")
    log.cell(row=3, column=7, value="Залито из живой базы кабинета приёмки")

    state = wb["_state"]
    state["B3"] = "снимок 08.11.2026"
    state["B4"] = datetime(2026, 11, 8, 0, 0)

    wb.save(out_path)

    counts = Counter(row["state"] for row in rows)
    print("rows:", len(rows), dict(counts))
    print("sever matched:", sum(1 for row in rows if sever.get(str(row["source_id"]).strip())))
    print("sever photos:", sum(1 for row in rows if tokens.get(str(row["source_id"]).strip())))
    print("accepted in Сверка:", min(300, len(slice_rows)),
          "| с фото СЖКХ:", sum(1 for row in slice_rows[:300] if tokens.get(str(row["source_id"]).strip())),
          "| rework:", len(rework))
    print("saved:", out_path, out_path.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
