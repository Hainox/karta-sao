"""Выгружает фотографии нарушений из приложений ГБУ МАЦ.

Каждое нарушение в приложении — это строка с фотографией и следующая за ней
строка «Адрес: … Нарушение: …». Скрипт раскладывает фотографии по районам и
собирает указатель: что за нарушение, к какому объекту и из какого документа.

Запуск:
    python work/export_mac_photos.py <каталог с docx> <каталог выгрузки>
"""
import re
import shutil
import sys
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side

NS = {
    'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
    'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
    'a': 'http://schemas.openxmlformats.org/drawingml/2006/main'
}
REL_NS = {'pr': 'http://schemas.openxmlformats.org/package/2006/relationships'}

CATEGORY_MARKERS = [
    ('ДТ', 'дворовых территорий'),
    ('МКД', 'многоквартирных домов'),
    ('ОДХ', 'объектов дорожного хозяйства'),
    ('ОО', 'объектов озеленения')
]

FORBIDDEN = re.compile(r'[\\/:*?"<>|\r\n\t]+')


def cell_text(cell):
    return ' '.join(''.join(node.text or '' for node in paragraph.findall('.//w:t', NS)).strip()
                    for paragraph in cell.findall('.//w:p', NS)).strip()


def cell_images(cell):
    return [node.get(f'{{{NS["r"]}}}embed') for node in cell.iter(f'{{{NS["a"]}}}blip')]


def parse_violation(text):
    address = text
    description = ''
    match = re.search(r'Нарушение:\s*(.*)$', text, re.DOTALL)
    if match:
        description = match.group(1).strip()
        address = text[:match.start()].strip()
    address = re.sub(r'^Адрес:\s*', '', address).strip()
    return address, description


def safe_name(value, limit=90):
    cleaned = FORBIDDEN.sub(' ', value).strip(' .')
    cleaned = re.sub(r'\s{2,}', ' ', cleaned)
    return cleaned[:limit].strip(' .') or 'нарушение'


def district_name(path):
    return re.sub(r'\s+август.*$', '', path.stem).strip()


def collect(path):
    """Возвращает список нарушений: район, категория, адрес, описание, файл картинки."""
    with zipfile.ZipFile(path) as archive:
        document = ET.fromstring(archive.read('word/document.xml'))
        relationships = ET.fromstring(archive.read('word/_rels/document.xml.rels'))
        rel_targets = {}
        for relation in relationships.findall('pr:Relationship', REL_NS):
            target = relation.get('Target')
            if target.startswith('/'):
                rel_targets[relation.get('Id')] = target.lstrip('/')
            else:
                rel_targets[relation.get('Id')] = f'word/{target}'

        records = []
        category = None
        pending = []

        def walk(container):
            nonlocal category, pending
            for child in container:
                tag = child.tag.split('}')[1]
                if tag == 'p':
                    text = ''.join(node.text or '' for node in child.findall('.//w:t', NS)).strip()
                    if text:
                        for name, marker in CATEGORY_MARKERS:
                            if marker in text.lower():
                                category = name
                elif tag == 'tbl':
                    for row in child.findall('w:tr', NS):
                        images = []
                        texts = []
                        for cell in row.findall('w:tc', NS):
                            images.extend(cell_images(cell))
                            text = cell_text(cell)
                            if text:
                                texts.append(text)
                        text = ' '.join(texts)
                        if text and 'Адрес' in text:
                            address, description = parse_violation(text)
                            records.append({
                                'Категория': category or '—',
                                'Адрес': address,
                                'Нарушение': description,
                                'Изображения': pending[:]
                            })
                            pending = []
                        elif images:
                            pending.extend(images)

        walk(document.find('w:body', NS))
    return records, rel_targets, path


def main():
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    target.mkdir(parents=True, exist_ok=True)

    rows = []
    total_photos = 0
    without_photo = 0
    for path in sorted(source.glob('*.docx')):
        district = district_name(path)
        folder = target / safe_name(district)
        if folder.exists():
            for stale in folder.iterdir():
                if stale.is_file():
                    stale.unlink()
        folder.mkdir(exist_ok=True)
        records, rel_targets, document_path = collect(path)
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            index = 0
            for record in records:
                index += 1
                media = record.pop('Изображения')
                saved = []
                for relation_id in media:
                    member = rel_targets.get(relation_id)
                    if not member or member not in names:
                        continue
                    extension = Path(member).suffix or '.jpg'
                    file_name = f'{index:04d} — {safe_name(record["Адрес"], 60)} — {safe_name(record["Нарушение"], 50)}{extension}'
                    destination = folder / file_name
                    counter = 2
                    while destination.exists():
                        destination = folder / f'{destination.stem} ({counter}){destination.suffix}'
                        counter += 1
                    with archive.open(member) as source_file, destination.open('wb') as target_file:
                        shutil.copyfileobj(source_file, target_file)
                    saved.append(file_name)
                if not saved:
                    without_photo += 1
                total_photos += len(saved)
                rows.append({
                    'Район': district,
                    '№': index,
                    'Категория': {'ДТ': 'ДТ', 'МКД': 'МКД', 'ОДХ': 'ОДХ', 'ОО': 'ОО'}.get(record['Категория'], record['Категория']),
                    'Адрес': record['Адрес'],
                    'Нарушение': record['Нарушение'],
                    'Файл': ' | '.join(saved),
                    'Документ': document_path.name
                })
        print(f'{district:<24} нарушений {len(records):>4}, фото {sum(1 for r in rows if r["Район"] == district):>4}')

    build_index(rows, target / 'Указатель.xlsx')
    print()
    print(f'фотографий выгружено: {total_photos}')
    print(f'нарушений без фотографии: {without_photo}')
    print(f'каталог: {target}')


def build_index(rows, target):
    book = Workbook()
    sheet = book.active
    sheet.title = 'Фото'
    headers = ['Район', '№', 'Категория', 'Адрес', 'Нарушение', 'Файл', 'Документ']
    thin = Side(style='thin', color='B7C0C8')
    sheet.append(headers)
    for cell in sheet[1]:
        cell.font = Font(bold=True)
        cell.fill = PatternFill('solid', fgColor='DDE7F0')
        cell.alignment = Alignment(horizontal='center', vertical='center', wrap_text=True)
        cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)
    for row in rows:
        sheet.append([row[key] for key in headers])
    for row in sheet.iter_rows(min_row=2):
        for cell in row:
            cell.border = Border(left=thin, right=thin, top=thin, bottom=thin)
            cell.alignment = Alignment(vertical='top', wrap_text=cell.column in (4, 5))
    widths = {'A': 20, 'B': 6, 'C': 11, 'D': 42, 'E': 42, 'F': 46, 'G': 34}
    for column, width in widths.items():
        sheet.column_dimensions[column].width = width
    sheet.freeze_panes = 'A2'
    sheet.auto_filter.ref = f'A1:G{sheet.max_row}'
    book.save(target)


if __name__ == '__main__':
    main()
