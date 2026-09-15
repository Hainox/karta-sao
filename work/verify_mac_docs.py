"""Сверяет подсчёт нарушений с числом фотографий и ищет в документах признак устранения.

Запуск: python work/verify_mac_docs.py <каталог с docx>
"""
import re
import sys
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

NS = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
IMG = re.compile(r'word/media/[^/]+$', re.IGNORECASE)


def cell_text(cell):
    return ' '.join(''.join(node.text or '' for node in paragraph.findall('.//w:t', NS)).strip()
                    for paragraph in cell.findall('.//w:p', NS)).strip()


def count_violations(document):
    total = 0
    for row in document.find('w:body', NS).iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}tr'):
        text = ' '.join(filter(None, (cell_text(cell) for cell in row.findall('w:tc', NS))))
        if 'Адрес' in text and 'Нарушение' in text:
            total += 1
    return total


def all_text(document):
    return ' '.join(node.text or '' for node in document.iter('{http://schemas.openxmlformats.org/wordprocessingml/2006/main}t'))


def main():
    source = Path(sys.argv[1])
    keywords = ['устран', 'доработк', 'контрол', 'выполнен']
    print(f'{"Документ":<28}{"нарушений":>10}{"фото":>8}{"совпадение":>12}')
    mismatches = []
    found_keywords = {}
    for path in sorted(source.glob('*.docx')):
        with zipfile.ZipFile(path) as archive:
            document = ET.fromstring(archive.read('word/document.xml'))
            images = len([name for name in archive.namelist() if IMG.search(name)])
        violations = count_violations(document)
        ok = 'да' if images == violations else 'НЕТ'
        if images != violations:
            mismatches.append((path.name, violations, images))
        print(f'{path.stem[:27]:<28}{violations:>10}{images:>8}{ok:>12}')
        text = all_text(document).lower()
        for keyword in keywords:
            if keyword in text:
                found_keywords.setdefault(keyword, []).append(path.stem)

    print()
    print(f'расхождений «нарушения против фото»: {len(mismatches)}')
    for name, violations, images in mismatches:
        print(f'   {name}: нарушений {violations}, фото {images}')
    print('упоминания признаков устранения в тексте документов:')
    for keyword in keywords:
        documents = found_keywords.get(keyword, [])
        print(f'   «{keyword}»: {len(documents)} документ(ов)' + (f' — {", ".join(documents[:3])}' if documents else ''))


if __name__ == '__main__':
    main()
