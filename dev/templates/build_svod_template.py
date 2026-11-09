# -*- coding: utf-8 -*-
"""Сборка шаблона Google-таблицы «ДП/СП: приёмка + сверка с Север-ЖКХ».

Шаблон пустой: только листы, шапки, проверки ввода, формулы и оформление.
Данные заливаются на этапе 3 (импорт среза) и дальше — скриптом syncCabinet.

Запуск:
    python dev/templates/build_svod_template.py [выходной_файл]

По умолчанию пишет dev/templates/svod-dp-sp-szhkh.xlsx.
Формулы записываются в синтаксисе OOXML (en-US, запятая) — Google Sheets
переводит их в локальный вид сам. IMAGE() и IFS() есть только в Sheets/Excel 2019+,
поэтому колонки с фото в шаблоне оставлены пустыми: их заполняет скрипт.
"""

import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.formatting.rule import FormulaRule
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

DISTRICTS = [
    ("Аэропорт", "aeroport"),
    ("Беговой", "begovoy"),
    ("Бескудниковский", "beskudnikovskiy"),
    ("Войковский", "voykovskiy"),
    ("Восточное Дегунино", "vostochnoe-degunino"),
    ("Головинский", "golovinskiy"),
    ("Дмитровский", "dmitrovskiy"),
    ("Западное Дегунино", "zapadnoe-degunino"),
    ("Коптево", "koptevo"),
    ("Левобережный", "levoberezhnyy"),
    ("Молжаниновский", "molzhaninovskiy"),
    ("Савеловский", "savelovskiy"),
    ("Сокол", "sokol"),
    ("Тимирязевский", "timiryazevskiy"),
    ("Ховрино", "hovrino"),
    ("Хорошевский", "horoshevskiy"),
]

DECISIONS = ["—", "Принято (сверка с С-ЖКХ)", "Вернуть на доработку"]
REASONS = ["Не тот объект", "Не тот ракурс", "Не видно площадку", "Площадка не убрана", "Дубль", "Другое"]
STATES = ["Нет фото", "На проверке", "Принято", "На доработке", "Снята"]
KINDS = ["ДП", "СП"]
HAS_TASK = ["есть", "нет"]

MAP_BASE = "https://hainox.github.io/karta-sao/districts/"

GREEN = "1F5137"
LIGHT_GREEN = "C6EFCE"
LIGHT_RED = "FFC7CE"
LIGHT_YELLOW = "FFEB9C"
LIGHT_GREY = "E7E6E6"
NOTE_GREY = "595959"

HEAD_FONT = Font(bold=True, color="FFFFFF", size=10)
HEAD_FILL = PatternFill("solid", fgColor=GREEN)
HEAD_ALIGN = Alignment(horizontal="center", vertical="center", wrap_text=True)
THIN = Side(style="thin", color="D0D7D2")
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
NOTE_FONT = Font(italic=True, color=NOTE_GREY, size=10)
TITLE_FONT = Font(bold=True, size=14, color=GREEN)

REG_LAST_ROW = 3001  # строки данных 2..3001
SV_LAST_ROW = 307  # лист «Сверка»: 300 строк


def style_header(ws, row, first_col, last_col, height=34):
    for col in range(first_col, last_col + 1):
        cell = ws.cell(row=row, column=col)
        cell.font = HEAD_FONT
        cell.fill = HEAD_FILL
        cell.alignment = HEAD_ALIGN
        cell.border = BORDER
    ws.row_dimensions[row].height = height


def add_list_validation(ws, formula, cells, allow_blank=True):
    dv = DataValidation(type="list", formula1=formula, allow_blank=allow_blank)
    dv.error = "Выберите значение из списка"
    dv.errorTitle = "Недопустимое значение"
    dv.prompt = "Значение берётся из листа «Справочники»"
    ws.add_data_validation(dv)
    dv.add(cells)
    return dv


def quoted(values):
    return '"' + ",".join(values) + '"'


# ---------------------------------------------------------------- Справочники

def build_references(ws):
    ws["A1"] = "Решение"
    ws["B1"] = "Причина"
    ws["C1"] = "Район"
    ws["D1"] = "Вид"
    ws["E1"] = "Слаг района"
    ws["F1"] = "Фильтр «Район»"
    ws["G1"] = "Легенда"

    for i, value in enumerate(DECISIONS, start=2):
        ws.cell(row=i, column=1, value=value)
    for i, value in enumerate(REASONS, start=2):
        ws.cell(row=i, column=2, value=value)
    for i, (name, slug) in enumerate(DISTRICTS, start=2):
        ws.cell(row=i, column=3, value=name)
        ws.cell(row=i, column=5, value=slug)

    ws["F2"] = "Все районы"
    for i in range(2, 18):
        ws.cell(row=i + 1, column=6, value="=C{}".format(i))

    for i, value in enumerate(KINDS, start=2):
        ws.cell(row=i, column=4, value=value)

    legend = [
        ("Принято (сверка с С-ЖКХ)", "зелёный: объект и ракурс подтверждены"),
        ("Вернуть на доработку", "красный: нужен новый снимок"),
        ("пусто / «—»", "решение не принято"),
        ("Нет фото", "серый: район ещё не загрузил снимок"),
        ("На проверке", "жёлтый: снимок ждёт приёмки"),
    ]
    for i, (value, text) in enumerate(legend, start=2):
        ws.cell(row=i, column=7, value=value)
        ws.cell(row=i, column=8, value=text)

    style_header(ws, 1, 1, 8, height=30)
    for letter, width in (("A", 26), ("B", 18), ("C", 20), ("D", 6), ("E", 22),
                          ("F", 20), ("G", 26), ("H", 46)):
        ws.column_dimensions[letter].width = width
    ws.freeze_panes = "A2"


# ---------------------------------------------------------------- Свод

def build_summary(ws):
    ws["A1"] = "ДП/СП: приёмка и сверка с Север-ЖКХ"
    ws["A1"].font = TITLE_FONT
    ws["A2"] = "Свод по районам. Данные кабинета приёмки обновляются каждые 10 минут, «Север ЖКХ» — раз в сутки."
    ws["A2"].font = NOTE_FONT

    meta = [
        ("Данные кабинета на", '=IF(COUNT(Реестр!I:I)=0,"нет данных",MAX(Реестр!I:I))'),
        ("Данные СЖКХ на", '=IF(_state!B2="","нет данных",_state!B2)'),
        ("Последняя синхронизация", '=IF(COUNT(Журнал!A:A)=0,"нет данных",MAX(Журнал!A:A))'),
        ("Статус синхронизации", "=_state!B3"),
    ]
    for i, (label, formula) in enumerate(meta, start=3):
        ws.cell(row=i, column=1, value=label).font = Font(bold=True, size=10)
        cell = ws.cell(row=i, column=2, value=formula)
        cell.alignment = Alignment(horizontal="left")

    kpi = [
        ("Всего площадок", '=COUNTA(Реестр!$B$2:$B$3001)-COUNTIF(Реестр!$H:$H,"Снята")'),
        ("Принято", '=COUNTIF(Реестр!$H:$H,"Принято")'),
        ("На проверке", '=COUNTIF(Реестр!$H:$H,"На проверке")'),
        ("На доработке", '=COUNTIF(Реестр!$H:$H,"На доработке")'),
        ("Нет фото", '=COUNTIF(Реестр!$H:$H,"Нет фото")'),
        ("% принято", "=IFERROR(B9/A9,0)"),
        ("Сверено", '=COUNTIF(Реестр!$R:$R,"Принято (сверка с С-ЖКХ)")+COUNTIF(Реестр!$R:$R,"Вернуть на доработку")'),
        ("Возвращено", '=COUNTIF(Реестр!$R:$R,"Вернуть на доработку")'),
    ]
    for i, (label, formula) in enumerate(kpi, start=1):
        ws.cell(row=8, column=i, value=label)
        cell = ws.cell(row=9, column=i, value=formula)
        cell.font = Font(bold=True, size=12)
        cell.alignment = Alignment(horizontal="center", vertical="center")
    style_header(ws, 8, 1, 8, height=32)
    ws.row_dimensions[9].height = 24
    ws["F9"].number_format = "0.0%"

    headers = ["Район", "Всего", "Принято", "На проверке", "На доработке", "Нет фото",
               "% принято", "Сверено", "Возврат", "Нет задачи СЖКХ"]
    for i, label in enumerate(headers, start=1):
        ws.cell(row=11, column=i, value=label)
    style_header(ws, 11, 1, 10, height=30)

    for idx in range(16):
        row = 12 + idx
        ws.cell(row=row, column=1, value="=Справочники!$C${}".format(idx + 2))
        ws.cell(row=row, column=2, value=(
            '=COUNTIF(Реестр!$C:$C,$A{0})-COUNTIFS(Реестр!$C:$C,$A{0},Реестр!$H:$H,"Снята")'
        ).format(row))
        for col, state in ((3, "Принято"), (4, "На проверке"), (5, "На доработке"), (6, "Нет фото")):
            ws.cell(row=row, column=col, value=(
                '=COUNTIFS(Реестр!$C:$C,$A{0},Реестр!$H:$H,"{1}")'
            ).format(row, state))
        ws.cell(row=row, column=7, value="=IFERROR(C{0}/B{0},0)".format(row))
        ws.cell(row=row, column=7).number_format = "0.0%"
        ws.cell(row=row, column=8, value=(
            '=COUNTIFS(Реестр!$C:$C,$A{0},Реестр!$R:$R,"Принято (сверка с С-ЖКХ)")'
            '+COUNTIFS(Реестр!$C:$C,$A{0},Реестр!$R:$R,"Вернуть на доработку")'
        ).format(row))
        ws.cell(row=row, column=9, value=(
            '=COUNTIFS(Реестр!$C:$C,$A{0},Реестр!$R:$R,"Вернуть на доработку")'
        ).format(row))
        ws.cell(row=row, column=10, value=(
            '=COUNTIFS(Реестр!$C:$C,$A{0},Реестр!$N:$N,"нет")'
        ).format(row))

    ws.cell(row=28, column=1, value="Итого").font = Font(bold=True)
    for col in range(2, 11):
        letter = get_column_letter(col)
        cell = ws.cell(row=28, column=col, value="=SUM({0}12:{0}27)".format(letter))
        cell.font = Font(bold=True)
    ws.cell(row=28, column=7, value="=IFERROR(C28/B28,0)")
    ws.cell(row=28, column=7).number_format = "0.0%"
    ws.cell(row=28, column=7).font = Font(bold=True)

    ws.conditional_formatting.add(
        "G12:G27",
        FormulaRule(formula=["$G12<0.5"], fill=PatternFill("solid", fgColor=LIGHT_RED),
                    stopIfTrue=True))
    ws.conditional_formatting.add(
        "G12:G27",
        FormulaRule(formula=["$G12<0.8"], fill=PatternFill("solid", fgColor=LIGHT_YELLOW),
                    stopIfTrue=True))
    ws.conditional_formatting.add(
        "G12:G27",
        FormulaRule(formula=["$G12>=0.8"], fill=PatternFill("solid", fgColor=LIGHT_GREEN)))

    ws.column_dimensions["A"].width = 30
    for col in range(2, 11):
        ws.column_dimensions[get_column_letter(col)].width = 15
    for row in (3, 4, 5):
        ws.cell(row=row, column=2).number_format = "dd.mm.yyyy hh:mm"
    ws.cell(row=6, column=2).alignment = Alignment(horizontal="left")


# ---------------------------------------------------------------- Реестр

REGISTRY_HEADERS = [
    "point_id", "ID площадки", "Район", "Вид", "Адрес площадки", "Широта", "Долгота",
    "Статус приёмки", "Загружено", "Проверено", "Комментарий префектуры", "ID фото",
    "Наше фото (URL)", "Задача СЖКХ", "ID задачи СЖКХ", "Дата задачи СЖКХ",
    "Фото СЖКХ (URL)", "Решение сверки", "Причина", "Комментарий сверки",
    "Кто проверил", "Когда проверено", "Отправлено в кабинет", "Автовердикт",
    "На карте", "Снимок СЖКХ",
]


def build_registry(ws):
    for i, label in enumerate(REGISTRY_HEADERS, start=1):
        ws.cell(row=1, column=i, value=label)
    style_header(ws, 1, 1, len(REGISTRY_HEADERS), height=40)

    for row in range(2, REG_LAST_ROW + 1):
        ws.cell(row=row, column=24, value=(
            '=IF($A{0}="","",IFS('
            '$H{0}="Снята","Снята",'
            '$R{0}="Принято (сверка с С-ЖКХ)","Сверено",'
            '$R{0}="Вернуть на доработку",IF($W{0}="","Возврат в очереди","Возврат применён"),'
            'AND($H{0}="Принято",$N{0}="есть"),"Есть оба фото — сверьте",'
            'AND($H{0}="Принято",$N{0}="нет"),"Нет эталона СЖКХ",'
            'AND($H{0}="На доработке",$N{0}="есть"),"Поменять: есть эталон",'
            'AND($H{0}="На доработке",$N{0}="нет"),"Поменять: эталона нет",'
            'AND($H{0}="Нет фото",$N{0}="есть"),"Добить: взять фото СЖКХ",'
            'AND($H{0}="Нет фото",$N{0}="нет"),"Нет фото и нет эталона",'
            '$H{0}="На проверке","Ждёт приёмки",'
            'TRUE,"Проверить вручную"))'
        ).format(row))
        ws.cell(row=row, column=25, value=(
            '=IF($C{0}="","",IFERROR(HYPERLINK("{1}"&'
            'VLOOKUP($C{0},Справочники!$C$2:$E$17,3,FALSE)&".html","На карте"),""))'
        ).format(row, MAP_BASE))

    widths = {"A": 38, "B": 14, "C": 18, "D": 6, "E": 44, "F": 11, "G": 11, "H": 16,
              "I": 18, "J": 18, "K": 36, "L": 38, "M": 46, "N": 12, "O": 38, "P": 16,
              "Q": 46, "R": 26, "S": 18, "T": 42, "U": 26, "V": 18, "W": 18, "X": 28,
              "Y": 13, "Z": 14}
    for letter, width in widths.items():
        ws.column_dimensions[letter].width = width
    for letter in ("A", "L", "M", "O", "Q"):
        ws.column_dimensions[letter].hidden = True

    ws.freeze_panes = "A2"
    ws.auto_filter.ref = "A1:Z{}".format(REG_LAST_ROW)

    add_list_validation(ws, quoted(STATES), "H2:H{}".format(REG_LAST_ROW))
    add_list_validation(ws, quoted(HAS_TASK), "N2:N{}".format(REG_LAST_ROW))
    add_list_validation(ws, "Справочники!$A$2:$A$4", "R2:R{}".format(REG_LAST_ROW))
    add_list_validation(ws, "Справочники!$B$2:$B$7", "S2:S{}".format(REG_LAST_ROW))
    add_list_validation(ws, "Справочники!$C$2:$C$17", "C2:C{}".format(REG_LAST_ROW))
    add_list_validation(ws, "Справочники!$D$2:$D$3", "D2:D{}".format(REG_LAST_ROW))

    for cols in ("F", "G"):
        for row in range(2, REG_LAST_ROW + 1):
            ws["{}{}".format(cols, row)].number_format = "0.000000"
    for col in ("I", "J", "V", "W"):
        for row in range(2, REG_LAST_ROW + 1):
            ws["{}{}".format(col, row)].number_format = "dd.mm.yyyy hh:mm"
    for col in ("P", "Z"):
        for row in range(2, REG_LAST_ROW + 1):
            ws["{}{}".format(col, row)].number_format = "dd.mm.yyyy"

    ws.conditional_formatting.add(
        "R2:R{}".format(REG_LAST_ROW),
        FormulaRule(formula=['$R2="Принято (сверка с С-ЖКХ)"'],
                    fill=PatternFill("solid", fgColor=LIGHT_GREEN)))
    ws.conditional_formatting.add(
        "R2:R{}".format(REG_LAST_ROW),
        FormulaRule(formula=['$R2="Вернуть на доработку"'],
                    fill=PatternFill("solid", fgColor=LIGHT_RED)))
    ws.conditional_formatting.add(
        "H2:H{}".format(REG_LAST_ROW),
        FormulaRule(formula=['$H2="На доработке"'],
                    fill=PatternFill("solid", fgColor=LIGHT_RED)))
    ws.conditional_formatting.add(
        "H2:H{}".format(REG_LAST_ROW),
        FormulaRule(formula=['$H2="Нет фото"'],
                    fill=PatternFill("solid", fgColor=LIGHT_GREY)))


# ---------------------------------------------------------------- Сверка

REVIEW_HEADERS = [
    "№", "№ задачи СЖКХ", "Район", "Адрес площадки", "Вид площадки", "ID площадки",
    "Фото СЖКХ (эталон)", "Наше фото", "Статус приёмки", "Решение", "Причина",
    "Комментарий", "Автовердикт", "На карте",
]


def build_review(ws):
    controls = [
        ("Район", "Все районы", "Справочники!$F$2:$F$18"),
        ("Статус", "Все", quoted(["Все"] + STATES)),
        ("Показать", "Все", quoted(["Все", "Только расхождения", "Только возвраты"])),
    ]
    for i, (label, value, formula) in enumerate(controls, start=1):
        ws.cell(row=i, column=1, value=label).font = Font(bold=True, size=10)
        ws.cell(row=i, column=2, value=value)
        add_list_validation(ws, formula, "B{}".format(i))
    ws.cell(row=4, column=1, value="Данные на").font = Font(bold=True, size=10)
    ws.cell(row=4, column=2, value='=IF(COUNT(Реестр!I:I)=0,"нет данных",MAX(Реестр!I:I))')
    ws.cell(row=4, column=2).number_format = "dd.mm.yyyy"
    ws.cell(row=5, column=1, value="Обновить").font = Font(bold=True, size=10)
    ws.cell(row=5, column=2, value="меню «ДП/СП» → Обновить сейчас").font = NOTE_FONT

    ws.cell(row=6, column=1,
            value="Строки — только принятые фото кабинета. «Принять» ничего не меняет, "
                  "«Вернуть на доработку» реально отзывает фото: район увидит его в «На доработке».").font = NOTE_FONT

    for i, label in enumerate(REVIEW_HEADERS, start=1):
        ws.cell(row=7, column=i, value=label)
    style_header(ws, 7, 1, len(REVIEW_HEADERS), height=38)
    ws.cell(row=7, column=15, value="point_id")
    ws.cell(row=7, column=16, value="photo_id")
    ws.cell(row=7, column=17, value="Отправлено")
    style_header(ws, 7, 15, 17, height=38)

    for row in range(8, SV_LAST_ROW + 1):
        ws.cell(row=row, column=1, value="=IF($O{0}=\"\",\"\",ROW()-7)".format(row))
        ws.cell(row=row, column=13, value=(
            '=IF($O{0}="","",IFERROR(VLOOKUP($O{0},Реестр!$A:$X,24,FALSE),""))'
        ).format(row))
        # Ссылка ведёт на точку, а не на район: карта подведёт к площадке и откроет её карточку.
        ws.cell(row=row, column=14, value=(
            '=IF($O{0}="","",IFERROR(HYPERLINK("{1}"&'
            'VLOOKUP(VLOOKUP($O{0},Реестр!$A:$C,3,FALSE),Справочники!$C$2:$E$17,3,FALSE)&'
            '".html?playground="&$O{0},"На карте"),""))'
        ).format(row, MAP_BASE))
        ws.row_dimensions[row].height = 110

    add_list_validation(ws, "Справочники!$A$2:$A$4", "J8:J{}".format(SV_LAST_ROW))
    add_list_validation(ws, "Справочники!$B$2:$B$7", "K8:K{}".format(SV_LAST_ROW))

    widths = {"A": 5, "B": 20, "C": 18, "D": 38, "E": 20, "F": 14, "G": 22, "H": 22,
              "I": 16, "J": 26, "K": 16, "L": 40, "M": 26, "N": 12, "O": 38, "P": 38,
              "Q": 20}
    for letter, width in widths.items():
        ws.column_dimensions[letter].width = width
    for letter in ("O", "P", "Q"):
        ws.column_dimensions[letter].hidden = True

    ws.freeze_panes = "A8"

    ws.conditional_formatting.add(
        "J8:J{}".format(SV_LAST_ROW),
        FormulaRule(formula=['$J8="Принято (сверка с С-ЖКХ)"'],
                    fill=PatternFill("solid", fgColor=LIGHT_GREEN)))
    ws.conditional_formatting.add(
        "J8:J{}".format(SV_LAST_ROW),
        FormulaRule(formula=['$J8="Вернуть на доработку"'],
                    fill=PatternFill("solid", fgColor=LIGHT_RED)))


# ---------------------------------------------------------------- На доработке

def build_rework(ws):
    ws["A1"] = "На доработке"
    ws["A1"].font = TITLE_FONT
    ws["A2"] = ("Заполняется скриптом: объекты со статусом «На доработке» или решением "
                "«Вернуть на доработку». Одна строка = одна площадка.")
    ws["A2"].font = NOTE_FONT
    headers = ["№", "Район", "Адрес площадки", "ID площадки", "Статус приёмки",
               "Комментарий префектуры", "Решение сверки", "Причина", "Комментарий сверки",
               "Кто проверил", "Когда проверено", "На карте"]
    for i, label in enumerate(headers, start=1):
        ws.cell(row=4, column=i, value=label)
    style_header(ws, 4, 1, len(headers), height=32)
    widths = {"A": 5, "B": 18, "C": 44, "D": 14, "E": 16, "F": 40, "G": 26, "H": 16,
              "I": 40, "J": 26, "K": 18, "L": 12}
    for letter, width in widths.items():
        ws.column_dimensions[letter].width = width
    ws.freeze_panes = "A5"


# ---------------------------------------------------------------- Расхождения

def build_gaps(ws):
    ws["A1"] = "Расхождения"
    ws["A1"].font = TITLE_FONT
    ws["A3"] = "Блок"
    ws["B3"] = "Что показывает"
    ws["C3"] = "На 06.11.2026"
    ws["D3"] = "Что делать"
    style_header(ws, 3, 1, 4, height=30)
    blocks = [
        ("1. Есть в СЖКХ, нет на карте",
         "Объекты с принятыми задачами в «Север ЖКХ», которых нет в слоях районов",
         11, "завести: 9 — Левобережная ул. 4 к.8 (Ховрино), 2 — Правды ул. 11 "
             "и Дмитровское шоссе 27"),
        ("2. Есть на карте, нет в списке СЖКХ",
         "Наши source_id, которых нет ни в списке площадок, ни в реестре задач",
         20, "проверить и снять через retired_at — вручную, не автоматически"),
        ("3. Дубли одной площадки",
         "Группы точек с одинаковым ID площадки",
         "203 группы / 442 ключа", "снять лишние скриптом retire-duplicate-playground-points"),
        ("4. Нет фото за период",
         "Объект есть, снимка нет — это не расхождение состава",
         588, "считать в «Своде», а не в этом листе"),
    ]
    for i, row in enumerate(blocks, start=4):
        for j, value in enumerate(row, start=1):
            cell = ws.cell(row=i, column=j, value=value)
            cell.alignment = Alignment(wrap_text=True, vertical="top")

    ws["A9"] = ("Важно: блок 1 — это реальные объекты, а не заглушки. У всех 11 в СЖКХ есть "
                "по 20 строк реестра и по 20 снимков; 11111111 и 33333333 — рабочие площадки "
                "с ID-заглушкой, их нельзя выбрасывать из-за странного ID.")
    ws["A9"].font = NOTE_FONT

    detail_headers = ["Блок", "ID", "Район", "Адрес", "Вид", "Источник", "Что делать", "Кто"]
    for i, label in enumerate(detail_headers, start=1):
        ws.cell(row=11, column=i, value=label)
    style_header(ws, 11, 1, len(detail_headers), height=30)

    for letter, width in (("A", 30), ("B", 16), ("C", 18), ("D", 44), ("E", 6),
                          ("F", 18), ("G", 44), ("H", 18)):
        ws.column_dimensions[letter].width = width
    ws.freeze_panes = "A12"


# ---------------------------------------------------------------- Журнал

def build_log(ws):
    headers = ["Дата и время", "Операция", "Добавлено", "Обновлено", "Ошибок", "Статус", "Сообщение"]
    for i, label in enumerate(headers, start=1):
        ws.cell(row=1, column=i, value=label)
    style_header(ws, 1, 1, len(headers), height=30)
    ws["A2"] = "2026-11-06 00:00"
    ws["B2"] = "шаблон создан"
    ws["F2"] = "OK"
    ws["G2"] = "Форма собрана, синхронизация не подключена"
    for letter, width in (("A", 20), ("B", 24), ("C", 12), ("D", 12), ("E", 10),
                          ("F", 12), ("G", 70)):
        ws.column_dimensions[letter].width = width
    ws.freeze_panes = "A2"


# ---------------------------------------------------------------- Методика

METHOD_TEXT = [
    ("ДП/СП: сверка эталонных фото с Север-ЖКХ", "title"),
    ("", None),
    ("Что это за таблица", "h"),
    ("Рабочее место сверки. Район сдаёт эталонное фото площадки, префектура смотрит его рядом "
     "с фото того же объекта из «Север ЖКХ» и решает: объект и ракурс совпадают или нужен новый "
     "снимок. Речь не о поиске нарушений, а о том, что сфотографирован именно тот объект "
     "и так, как надо.", None),
    ("", None),
    ("Одна строка = одна площадка", "h"),
    ("2 837 активных площадок: 2 045 детских и 792 спортивных. В строке — один снимок. "
     "Все 16 районов САО сразу, без пилота.", None),
    ("", None),
    ("Два разных «принято»", "h"),
    ("«Принято» в кабинете — префектура приняла снимок подрядчика (колонка «Статус приёмки»). "
     "«Принято» в СЖКХ — у них закрыта задача за период (колонка «Задача СЖКХ»). "
     "Это разные вещи, их нельзя смешивать.", None),
    ("", None),
    ("Что делает решение", "h"),
    ("«Принято (сверка с С-ЖКХ)» — только отметка: фото уже принято, ничего не меняется. "
     "«Вернуть на доработку» — реально отзывает принятое фото в кабинете: статус становится "
     "«На доработке», район видит причину и обязан переснять. Действие уходит на сервер "
     "в течение 10 минут и попадает в audit_log.", None),
    ("", None),
    ("Регламент обновления", "h"),
    ("Кабинет → таблица: каждые 10 минут, 07:00–21:00; ночью раз в час. "
     "Решения → кабинет: каждые 10 минут со смещением 2 минуты. "
     "«Север ЖКХ»: раз в сутки, 02:00–05:00 (закрытый кабинет, вход выполняет человек).", None),
    ("", None),
    ("Почему 10, а не 5 минут", "h"),
    ("288 запусков в сутки по 20–30 секунд — 96–144 минуты, это выходит за квоту Apps Script "
     "(90 минут для обычного аккаунта). 144 запуска — 48–72 минуты, остаётся запас. "
     "Для пиковой приёмки есть кнопка «Обновить сейчас».", None),
    ("", None),
    ("Колонки, которые можно править", "h"),
    ("Только «Решение», «Причина» и «Комментарий». Остальное заполняет скрипт: "
     "статус приёмки живёт в кабинете, а не в таблице.", None),
    ("", None),
    ("Формулы", "h"),
    ("«Автовердикт» — подсказка, а не решение: он говорит, есть ли оба фото и чего не хватает, "
     "но не сравнивает снимки. Сравнивает человек.", None),
    ("Фото: =IMAGE(url;4;160;120) — режим 4, высота 160, ширина 120. В шаблоне колонки фото "
     "пустые: их заполняет скрипт, потому что IMAGE() есть только в Google Sheets и Excel 2019+.", None),
    ("", None),
    ("Что согласовано 07.11.2026", "h"),
    ("Возврат реальный, а не пометка. Таблица — про эталонные фото, а не про нарушения. "
     "Подписанные ссылки на превью согласованы службой безопасности. Все 16 районов сразу. "
     "Расхождения: 11 объектов есть в СЖКХ и отсутствуют на карте, 20 наших точек нет в списке СЖКХ.", None),
    ("", None),
    ("Служебные листы", "h"),
    ("«Справочники» — списки для выпадающих меню. «_state» (скрыт) — курсор синхронизации и дата "
     "снимка СЖКХ. «Журнал» — каждая синхронизация: что, когда, сколько, ошибки.", None),
]


def build_method(ws):
    ws.column_dimensions["A"].width = 150
    for i, (text, kind) in enumerate(METHOD_TEXT, start=1):
        cell = ws.cell(row=i, column=1, value=text)
        cell.alignment = Alignment(wrap_text=True, vertical="top")
        if kind == "title":
            cell.font = Font(bold=True, size=14, color=GREEN)
        elif kind == "h":
            cell.font = Font(bold=True, size=11, color=GREEN)
        else:
            cell.font = Font(size=10)


# ---------------------------------------------------------------- _state

def build_state(ws):
    ws["A1"] = "since"
    ws["A2"] = "sever_captured_at"
    ws["A3"] = "sync_status"
    ws["A4"] = "last_sync"
    ws["B3"] = "не синхронизировано"
    ws.column_dimensions["A"].width = 24
    ws.column_dimensions["B"].width = 28
    ws.sheet_state = "hidden"


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).with_name("svod-dp-sp-szhkh.xlsx")
    out.parent.mkdir(parents=True, exist_ok=True)

    wb = Workbook()
    wb.active.title = "Свод"
    sheets = {
        "Реестр": build_registry,
        "Сверка": build_review,
        "На доработке": build_rework,
        "Расхождения": build_gaps,
        "Справочники": build_references,
        "Журнал": build_log,
        "Методика": build_method,
        "_state": build_state,
    }
    build_summary(wb["Свод"])
    for name, builder in sheets.items():
        builder(wb.create_sheet(name))

    wb.active = 0
    wb.properties.title = "ДП/СП: приёмка и сверка с Север-ЖКХ"
    wb.properties.creator = "karta-sao"
    wb.properties.description = "Шаблон формы. Данные заливаются скриптом."
    wb.save(out)
    print("saved:", out, out.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
