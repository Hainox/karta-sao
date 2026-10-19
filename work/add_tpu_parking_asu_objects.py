"""Add parking lots and parking pockets from the ASU ODH export to the TPU digitization map.

The export lists ASU objects (one row per lot or pocket) with WGS84 centre points,
so they go on the map as markers without contours. Rerunning replaces the
previous ASU objects; TPU and contour parkings from the original workbook stay.
"""
import argparse
from pathlib import Path

import openpyxl

from build_tpu_parking_map import AVD_OWNER, page_data, write_data


COLUMNS = ['№', 'Район', 'Баланс', 'Участок', 'id ОДХ', 'Улица', 'id_объекта_asu', 'center_lat', 'center_lon',
           'Количество фото (подзадач)', 'Количество парковочных мест', 'Площадь_кв.м', 'Тип']
SUBKINDS = {'Парковка': 'lot', 'Парковочный карман': 'pocket'}


def number(value):
    """Whole numbers come from Excel as floats too; show them without «.0»."""
    return int(value) if isinstance(value, float) and value.is_integer() else value


def asu_records(workbook, base_records, districts):
    rows = list(openpyxl.load_workbook(workbook, data_only=True, read_only=True).active.values)
    if list(rows[0][:len(COLUMNS)]) != COLUMNS:
        raise ValueError('Unexpected columns: ' + ', '.join(map(str, rows[0])))
    parents = {r['sourceNumber']: r for r in base_records}
    records = []
    for row_number, row in enumerate(rows[1:], 2):
        values = dict(zip(COLUMNS, row))
        if not any(values.values()):
            continue
        kind_name, district, holder = values['Тип'], values['Район'], (values['Баланс'] or '').strip()
        if kind_name not in SUBKINDS or district not in districts:
            raise ValueError(f'Invalid object type or district in row {row_number}')
        lat, lon = float(values['center_lat']), float(values['center_lon'])
        if not (55.7 < lat < 56.0 and 37.3 < lon < 37.7):
            raise ValueError(f'Point outside SAO in row {row_number}')
        source_id = str(int(values['id_объекта_asu']))
        odh_id = str(int(values['id ОДХ']))
        # Фотофиксация закреплена за балансодержателем: АвД САО или жилищник района.
        if holder.casefold() == AVD_OWNER.casefold():
            group, holder_name = AVD_OWNER, AVD_OWNER
        elif holder == district:
            group, holder_name = district, 'Жилищник ' + district
        else:
            raise ValueError(f'Balance holder {holder!r} differs from district in row {row_number}')
        street = str(values['Улица']).strip()
        label = kind_name + ': ' + street
        # Карточка без повторяющихся пояснений: 3,9 тыс. объектов идут прямо в страницу, каждый байт на счету.
        properties = {
            'ID объекта': source_id, 'Тип': kind_name, 'Район': district, 'Балансодержатель': holder_name,
            'ID ОДХ': odh_id, 'Участок': number(values['Участок']),
            'Парковочных мест': number(values['Количество парковочных мест']),
            'Площадь, кв. м': number(values['Площадь_кв.м']),
            'Фото по заданию': number(values['Количество фото (подзадач)']),
        }
        if odh_id in parents:
            properties['Входит в объект'] = parents[odh_id]['label']
        properties['Источник'] = 'Выгрузка АСУ ОДХ, строка ' + str(row_number)
        records.append({
            'id': 'parking:' + source_id, 'kind': 'parking', 'subkind': SUBKINDS[kind_name],
            'lat': lat, 'lon': lon, 'label': label, 'group': group,
            'sourceNumber': source_id, 'sourceRow': row_number,
            'properties': properties, 'issues': [], 'alternate': None,
            'searchKey': ' '.join(dict.fromkeys([label, district, group, source_id, odh_id])),
        })
    ids = [r['id'] for r in base_records + records]
    if len(set(ids)) != len(ids):
        raise ValueError('ASU object IDs collide with each other or with existing map objects')
    return records


def main(workbook):
    data = page_data()
    base = [r for r in data['records'] if not r.get('subkind')]
    added = asu_records(workbook, base, set(data['districts']))
    write_data(base + added, data['districts'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('workbook', type=Path)
    main(parser.parse_args().workbook)
