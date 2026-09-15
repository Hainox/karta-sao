"""Собирает таблицу «Об устранении нарушений от ГБУ МАЦ» по образцу эталона.

На вход идёт сводка из build_mac_report.py, на выход — книга Excel с теми же
колонками, что в эталонной таблице.

    python work/build_mac_table.py <сводка.csv> <куда положить xlsx> [--месяц АВГУСТ]
"""
import csv
import sys
from pathlib import Path

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

THIN = Side(style='thin', color='9AA5AE')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEADER_FILL = PatternFill('solid', fgColor='DDE7F0')
TOTAL_FILL = PatternFill('solid', fgColor='EFEFEF')
CENTER = Alignment(horizontal='center', vertical='center', wrap_text=True)
LEFT = Alignment(horizontal='left', vertical='center')

HEADERS = [
    ('A', '№ п/п', None),
    ('B', 'Округ', None),
    ('C', 'Район', None),
    ('D', 'Всего нарушений\nза текущий период', None),
    ('E', 'Из них по ДТ', 'Всего'),
    ('F', 'Из них по ДТ', 'Устранено'),
    ('G', 'Из них по МКД', 'Всего'),
    ('H', 'Из них по МКД', 'Устранено'),
    ('I', 'Из них по ОДХ', 'Всего'),
    ('J', 'Из них по ОДХ', 'Устранено'),
    ('K', 'Из них по ОО', 'Всего'),
    ('L', 'Из них по ОО', 'Устранено'),
    ('M', 'Всего нарушений\nустранено', None),
    ('N', 'Возвращено\nна доработку', None),
    ('O', '% устраненных\nнарушений', None),
    ('P', 'Остается\nна контроле', None)
]


def read_summary(path):
    with Path(path).open(encoding='utf-8-sig', newline='') as handle:
        rows = list(csv.DictReader(handle, delimiter=';'))
    total = [row for row in rows if row['Район'] == 'Итого']
    districts = [row for row in rows if row['Район'] != 'Итого']
    return districts, (total[0] if total else None)


def build(districts, total, month):
    workbook = Workbook()
    sheet = workbook.active
    sheet.title = 'Устранение нарушений'

    sheet.merge_cells('A1:P1')
    title = sheet['A1']
    title.value = f'Об устранении нарушений от ГБУ «МАЦ» — {month.upper()}'
    title.font = Font(bold=True, size=13)
    title.alignment = CENTER

    for column, header, sub in HEADERS:
        cell = sheet[f'{column}2']
        cell.value = header
        cell.font = Font(bold=True)
        cell.alignment = CENTER
        cell.fill = HEADER_FILL
        cell.border = BORDER
        if sub:
            sheet[f'{column}3'] = sub
        sheet[f'{column}3'].font = Font(bold=True)
        sheet[f'{column}3'].alignment = CENTER
        sheet[f'{column}3'].border = BORDER
        sheet[f'{column}3'].fill = HEADER_FILL

    for index in range(1, 17):
        column = get_column_letter(index)
        sheet[f'{column}4'] = index
        sheet[f'{column}4'].alignment = CENTER
        sheet[f'{column}4'].border = BORDER
        sheet[f'{column}4'].font = Font(size=9, color='708090')

    first_row = 5
    for offset, district in enumerate(districts):
        row = first_row + offset
        sheet[f'A{row}'] = offset + 1
        sheet[f'B{row}'] = 'САО'
        sheet[f'C{row}'] = district['Район']
        sheet[f'D{row}'] = int(district['Всего'])
        sheet[f'E{row}'] = int(district['ДТ'])
        sheet[f'G{row}'] = int(district['МКД'])
        sheet[f'I{row}'] = int(district['ОДХ'])
        sheet[f'K{row}'] = int(district['ОО'])
        sheet[f'M{row}'] = f'=SUM(F{row},H{row},J{row},L{row})'
        sheet[f'O{row}'] = f'=IFERROR(M{row}/D{row},0)'
        sheet[f'P{row}'] = f'=D{row}-M{row}'
        for column in 'ABCDEFGHIJKLMNOP':
            cell = sheet[f'{column}{row}']
            cell.border = BORDER
            cell.alignment = LEFT if column in ('B', 'C') else CENTER
        sheet[f'O{row}'].number_format = '0%'

    total_row = first_row + len(districts)
    sheet[f'C{total_row}'] = 'Итого:'
    for column in ('D', 'E', 'G', 'I', 'K', 'M', 'N'):
        sheet[f'{column}{total_row}'] = f'=SUM({column}{first_row}:{column}{total_row - 1})'
    sheet[f'O{total_row}'] = f'=IFERROR(M{total_row}/D{total_row},0)'
    sheet[f'P{total_row}'] = f'=D{total_row}-M{total_row}'
    for column in 'ABCDEFGHIJKLMNOP':
        cell = sheet[f'{column}{total_row}']
        cell.font = Font(bold=True)
        cell.fill = TOTAL_FILL
        cell.border = BORDER
        cell.alignment = LEFT if column == 'C' else CENTER
    sheet[f'O{total_row}'].number_format = '0%'

    sheet.column_dimensions['A'].width = 7
    sheet.column_dimensions['B'].width = 8
    sheet.column_dimensions['C'].width = 22
    for column in 'DEFGHIJKL':
        sheet.column_dimensions[column].width = 10
    sheet.column_dimensions['M'].width = 12
    sheet.column_dimensions['N'].width = 12
    sheet.column_dimensions['O'].width = 12
    sheet.column_dimensions['P'].width = 12
    sheet.row_dimensions[2].height = 42
    sheet.freeze_panes = 'D5'

    notes = workbook.create_sheet('Откуда данные')
    notes.column_dimensions['A'].width = 118
    lines = [
        ('Источник', True),
        ('Приложения районов «<Район> август приложение устранения.docx» — 17 файлов из архива САО (17).zip.', False),
        ('В каждом приложении четыре таблицы фотофиксации:', False),
        ('• дворовые территории и внутриквартальные проезды — колонки ДТ;', False),
        ('• многоквартирные дома — колонки МКД;', False),
        ('• объекты дорожного хозяйства — колонки ОДХ;', False),
        ('• объекты озеленения — колонки ОО.', False),
        ('', False),
        ('Как считалось', True),
        ('Одно нарушение — одна строка «Адрес: … Нарушение: …» в таблице приложения.', False),
        ('Число строк сверено с числом фотографий в документе: в 14 приложениях из 17 совпало точно,', False),
        ('в трёх фотографий меньше, чем строк (Войковский 188 против 189, Сокол 124 против 125,', False),
        ('Хорошевский 313 против 320) — считается по строкам, то есть по факту зафиксированных нарушений.', False),
        ('', False),
        ('Чего в архиве нет', True),
        ('Устранённых нарушений в приложениях нет: в тексте документов ни разу не встречается «устран».', False),
        ('Поэтому колонки «Устранено», «Возвращено на доработку», «%» и «Остается на контроле» оставлены', False),
        ('пустыми и считаются формулами: заполните четыре колонки «Устранено» — итог, процент', False),
        ('и остаток на контроле посчитаются сами.', False),
        ('', False),
        ('Если данные об устранении придут из реестра МАЦ, пришлите их тем же файлом — подставлю.', True),
    ]
    for index, (line, bold) in enumerate(lines, start=1):
        cell = notes[f'A{index}']
        cell.value = line
        cell.font = Font(bold=bold)
    return workbook


def main():
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    month = 'август'
    if '--месяц' in sys.argv:
        month = sys.argv[sys.argv.index('--месяц') + 1]
    districts, total = read_summary(source)
    workbook = build(districts, total, month)
    workbook.save(target)
    print(f'таблица собрана: {target}')
    print(f'районов: {len(districts)}, нарушений всего: {sum(int(row["Всего"]) for row in districts)}')
    if total:
        print(f'по категориям — ДТ {total["ДТ"]}, МКД {total["МКД"]}, ОДХ {total["ОДХ"]}, ОО {total["ОО"]}')


if __name__ == '__main__':
    main()
