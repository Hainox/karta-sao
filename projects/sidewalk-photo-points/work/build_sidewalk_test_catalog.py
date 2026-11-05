"""Convert the survey workbook into a private, server-only point and frame catalog."""
import argparse
import json
import math
from collections import Counter
from pathlib import Path

from openpyxl import load_workbook

HEADERS = (
    'ID точки', 'ID задания', 'Район', 'Баланс', 'Улица', 'ID тротуара в точке',
    'Широта (WGS 84)', 'Долгота (WGS 84)', 'Количество кадров', 'Азимут 1 (°)',
    'ID кадра 1', 'ID тротуаров', 'Азимут 2 (°)', 'ID кадра 2', 'ID тротуаров', 'ID ОДХ',
)
DISTRICTS = {
    'Аэропорт', 'Беговой', 'Бескудниковский', 'Войковский', 'Восточное Дегунино',
    'Головинский', 'Дмитровский', 'Западное Дегунино', 'Коптево', 'Левобережный',
    'Молжаниновский', 'Савеловский', 'Сокол', 'Тимирязевский', 'Ховрино', 'Хорошевский',
}


def field(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not str(value).strip():
        raise ValueError('ожидается непустое текстовое поле или ID')
    return str(value).strip()


def number(value, lower, upper):
    if type(value) not in (int, float) or not math.isfinite(value) or not lower <= value < upper:
        raise ValueError(f'некорректное число: {value!r}')
    return value


def build(source):
    workbook = load_workbook(source, read_only=True, data_only=True)
    try:
        rows = workbook.active.iter_rows(values_only=True)
        if next(rows, ()) != HEADERS:
            raise ValueError('Заголовки не совпадают с форматом «Тротуары 2.0».')
        points, point_ids, frame_ids = [], set(), set()
        for index, row in enumerate(rows, 2):
            if all(value is None for value in row):
                continue
            try:
                point_id, task_id, district, balance, street, sidewalk_id = map(field, row[:6])
                if point_id in point_ids or district not in DISTRICTS:
                    raise ValueError('повтор ID точки или неизвестный район')
                lat, lon = number(row[6], 55.7, 56.05), number(row[7], 37.2, 37.8)
                count = row[8]
                if type(count) is not int or count not in (1, 2) or (count == 1 and any(value is not None for value in row[12:15])):
                    raise ValueError('число кадров не соответствует заполненным слотам')
                slots = []
                for start in (9, 12)[:count]:
                    azimuth = number(row[start], 0, 360)
                    frame_id, covered = map(field, row[start + 1:start + 3])
                    if frame_id in frame_ids:
                        raise ValueError('повтор ID кадра')
                    frame_ids.add(frame_id)
                    slots.append(dict(id=frame_id, azimuth=azimuth, sidewalkIds=covered))
                points.append(dict(id=point_id, taskId=task_id, district=district, balance=balance,
                                   street=street, sidewalkId=sidewalk_id, coordinates=[lon, lat],
                                   slots=slots, roadId=field(row[15])))
                point_ids.add(point_id)
            except ValueError as error:
                raise ValueError(f'Строка {index}: {error}') from error
        if not points:
            raise ValueError('Нет точек.')
        return dict(version=1, points=points)
    finally:
        workbook.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('workbook', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    catalog = build(args.workbook)
    args.output.write_text(json.dumps(catalog, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    points = catalog['points']
    print(f"{len(points)} точек, {sum(len(p['slots']) for p in points)} слотов, {len(Counter(p['district'] for p in points))} районов")


if __name__ == '__main__':
    main()
