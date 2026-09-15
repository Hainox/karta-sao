"""Собирает сводку нарушений ГБУ МАЦ по приложениям районов.

Каждое приложение — четыре таблицы фотофиксации: дворовые территории (ДТ),
многоквартирные дома (МКД), объекты дорожного хозяйства (ОДХ) и объекты
озеленения (ОО). Одно нарушение — это одна строка с адресом и описанием.

Запуск:
    python work/build_mac_report.py <каталог с docx> <куда положить csv>
"""
import csv
import re
import sys
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}

CATEGORY_MARKERS = [
    ('ДТ', 'дворовых территорий'),
    ('МКД', 'многоквартирных домов'),
    ('ОДХ', 'объектов дорожного хозяйства'),
    ('ОО', 'объектов озеленения')
]


def cell_text(cell):
    return ' '.join(''.join(node.text or '' for node in paragraph.findall('.//w:t', NS)).strip()
                    for paragraph in cell.findall('.//w:p', NS)).strip()


def blocks(document):
    body = document.find('w:body', NS)
    for child in body:
        tag = child.tag.split('}')[1]
        if tag == 'p':
            text = ''.join(node.text or '' for node in child.findall('.//w:t', NS)).strip()
            if text:
                yield 'p', text
        elif tag == 'tbl':
            yield 'tbl', child


def category_of(paragraph):
    lowered = paragraph.lower()
    for name, marker in CATEGORY_MARKERS:
        if marker in lowered:
            return name
    return None


def count_violations(table):
    total = 0
    for row in table.findall('w:tr', NS):
        text = ' '.join(filter(None, (cell_text(cell) for cell in row.findall('w:tc', NS))))
        if 'Адрес' in text and 'Нарушение' in text:
            total += 1
    return total


def district_name(path):
    name = path.stem
    return re.sub(r'\s+август.*$', '', name).strip()


def parse_document(path):
    with zipfile.ZipFile(path) as archive:
        document = ET.fromstring(archive.read('word/document.xml'))
    counts = {}
    current = None
    unknown = []
    for kind, value in blocks(document):
        if kind == 'p':
            found = category_of(value)
            if found:
                current = found
            continue
        if current is None:
            unknown.append(count_violations(value))
            continue
        counts[current] = counts.get(current, 0) + count_violations(value)
    return counts, unknown


def main():
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    files = sorted(source.glob('*.docx'))
    if not files:
        raise SystemExit(f'В каталоге {source} нет файлов .docx')

    rows = []
    for path in files:
        counts, unknown = parse_document(path)
        district = district_name(path)
        total = sum(counts.values())
        rows.append({
            'Район': district,
            'ДТ': counts.get('ДТ', 0),
            'МКД': counts.get('МКД', 0),
            'ОДХ': counts.get('ОДХ', 0),
            'ОО': counts.get('ОО', 0),
            'Всего': total,
            'Таблиц без заголовка': len(unknown)
        })

    rows.sort(key=lambda row: (row['Район'] != 'АвД САО', row['Район']))
    with target.open('w', encoding='utf-8-sig', newline='') as handle:
        writer = csv.DictWriter(handle, fieldnames=['Район', 'ДТ', 'МКД', 'ОДХ', 'ОО', 'Всего', 'Таблиц без заголовка'], delimiter=';')
        writer.writeheader()
        writer.writerows(rows)
        writer.writerow({
            'Район': 'Итого',
            'ДТ': sum(row['ДТ'] for row in rows),
            'МКД': sum(row['МКД'] for row in rows),
            'ОДХ': sum(row['ОДХ'] for row in rows),
            'ОО': sum(row['ОО'] for row in rows),
            'Всего': sum(row['Всего'] for row in rows)
        })

    print(f'{"Район":<24}{"ДТ":>6}{"МКД":>6}{"ОДХ":>6}{"ОО":>6}{"Всего":>8}')
    for row in rows:
        print(f'{row["Район"]:<24}{row["ДТ"]:>6}{row["МКД"]:>6}{row["ОДХ"]:>6}{row["ОО"]:>6}{row["Всего"]:>8}')
    print('-' * 56)
    print(f'{"Итого":<24}{sum(r["ДТ"] for r in rows):>6}{sum(r["МКД"] for r in rows):>6}'
          f'{sum(r["ОДХ"] for r in rows):>6}{sum(r["ОО"] for r in rows):>6}{sum(r["Всего"] for r in rows):>8}')
    print(f'сводка: {target}')


if __name__ == '__main__':
    main()
