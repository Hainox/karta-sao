"""Read-only comparison of the supplied parking workbook with a map and API catalog."""
import argparse, csv, hashlib, json, re, urllib.request
from pathlib import Path
import openpyxl

ROOT = Path(__file__).resolve().parents[3]

def check(workbook, output):
    content = urllib.request.urlopen('https://hainox.github.io/karta-sao/object-maps/tpu-parking.html').read().decode()
    data = json.loads(re.search(r'<script id="map-data" type="application/json">(.*?)</script>', content, re.S).group(1))
    records = {r['id']: r for r in data['records']}
    live = json.load(urllib.request.urlopen('https://obhod-sao.ru/photo-api/object-photo-points/slots/public'))
    counts = {r['object_key']: r['required'] for r in live['objects']}
    catalog = {r['id']: r for r in json.loads((ROOT / 'photo-service/src/tpu-points/tpu-objects.json').read_text(encoding='utf-8'))}
    rows = list(openpyxl.load_workbook(workbook, data_only=True, read_only=True).active.values)
    expected_headers = ['№', 'Район', 'Участок', 'id ОДХ', 'Улица', 'id Парковки', 'Координаты', 'Количество фото (подзадач)', 'Количество парковочных мест', 'Площадь_кв.м', 'Тип']
    if list(rows[0]) != expected_headers:
        raise ValueError('Неожиданные заголовки Excel')
    result, seen = [], set()
    for index, row in enumerate(rows[1:], 2):
        if not any(v is not None for v in row): continue
        _, district, section, parent, street, source_id, coords, photos, spaces, area, kind = row
        key = 'parking:' + str(int(source_id))
        if key in seen: raise ValueError('Повторный ID ' + key)
        seen.add(key)
        if not isinstance(photos, int) or not 1 <= photos <= 50: raise ValueError('Некорректное число фото: ' + key)
        record, obj = records.get(key), catalog.get(key)
        errors = []
        if not record or not obj: errors.append('Нет объекта')
        else:
            prop = record['properties']
            lat, lon = map(lambda v: float(v.replace(',', '.')), str(coords).split())
            fields = [('Фото', prop.get('Фото по заданию'), photos), ('Слоты каталога', obj.get('photos', 1), photos), ('Слоты сервера', counts.get(key, obj.get('photos', 1)), photos), ('ID ОДХ', str(prop.get('ID ОДХ')), str(int(parent))), ('Участок', prop.get('Участок'), section), ('Парковочных мест', prop.get('Парковочных мест'), spaces), ('Площадь', prop.get('Площадь, кв. м'), area), ('Тип', prop.get('Тип'), kind), ('Улица', record['label'].removeprefix(kind + ': '), str(street).strip()), ('Ответственный', record['group'].casefold(), str(district).casefold())]
            for name, actual, expected in fields:
                if actual != expected: errors.append(name)
            if abs(record['lat'] - lat) > 1e-8 or abs(record['lon'] - lon) > 1e-8: errors.append('Координаты')
        result.append({'Строка Excel': index, 'ID объекта': key, 'Фото Excel': photos, 'Фото карта': record and record['properties'].get('Фото по заданию'), 'Слоты каталога': obj and obj.get('photos',1), 'Слоты сервера': counts.get(key, obj.get('photos',1) if obj else None), 'Результат': '; '.join(errors) or 'Совпадает'})
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(result[0]), delimiter=';'); writer.writeheader(); writer.writerows(result)
    summary = {'file': workbook.name, 'sha256': hashlib.sha256(workbook.read_bytes()).hexdigest(), 'checked': len(result), 'photos': sum(r['Фото Excel'] for r in result), 'mismatches': sum(r['Результат'] != 'Совпадает' for r in result), 'other_map_objects': len(records) - len(result)}
    output.with_suffix('.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(summary, ensure_ascii=False))
    return summary

if __name__ == '__main__':
    parser = argparse.ArgumentParser(); parser.add_argument('workbook', type=Path); parser.add_argument('output', type=Path)
    args = parser.parse_args(); raise SystemExit(1 if check(args.workbook, args.output)['mismatches'] else 0)
