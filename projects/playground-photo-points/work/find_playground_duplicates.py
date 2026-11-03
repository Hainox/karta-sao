"""Лишние точки фото площадок ДП/СП: несколько точек таблицы на одну площадку АСУ ОДС.

Точки слоя «Фото площадок ДП/СП» на картах районов взяты из таблицы
(districts/layers/<район>/dp_table.geojson, sp_table.geojson), где одна площадка
нередко записана несколькими строками — после благоустройства или по разным
адресам дома. Районы жалуются: «по АСУ одна площадка, у вас три точки».

Правило: одна площадка АСУ ОДС (контур dp.geojson / sp.geojson того же вида) —
одна точка фото. Точка относится к контуру, если лежит в нём или не дальше ~5 м
от края. Группы из двух и больше точек пишутся в
photo-service/scripts/retire-lists/playground-duplicates.json; какую точку оставить,
решает скрипт снятия на сервере по фото (принятое > на проверке > возвращённое >
ближайшая к центру площадки). Точки вне контуров не трогаются.

Запуск:  python3 find_playground_duplicates.py
"""
import json
import math
from pathlib import Path

from shapely.geometry import Point, shape
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[3]
LAYERS = ROOT / 'districts' / 'layers'
OUT = ROOT / 'photo-service' / 'scripts' / 'retire-lists' / 'playground-duplicates.json'
SLUGS = ['aeroport', 'begovoy', 'beskudnikovskiy', 'voykovskiy', 'vostochnoe-degunino', 'golovinskiy',
         'dmitrovskiy', 'zapadnoe-degunino', 'koptevo', 'levoberezhnyy', 'molzhaninovskiy', 'savelovskiy',
         'sokol', 'timiryazevskiy', 'hovrino', 'horoshevskiy']
NEAR_DEG = 0.00006  # ~4–7 м: точка чуть за краем контура


def main():
    groups = []
    for slug in SLUGS:
        for kind in ('dp', 'sp'):
            points = json.loads((LAYERS / slug / f'{kind}_table.geojson').read_text(encoding='utf-8'))['features']
            contours = json.loads((LAYERS / slug / f'{kind}.geojson').read_text(encoding='utf-8'))['features']
            shapes = [shape(f['geometry']).buffer(0) for f in contours]
            tree = STRtree(shapes)
            found = {}
            for feature in points:
                pt = Point(feature['geometry']['coordinates'])
                hit = [int(i) for i in tree.query_nearest(pt, max_distance=NEAR_DEG)]
                if hit:
                    found.setdefault(hit[0], []).append(feature)
            for index, members in sorted(found.items()):
                if len(members) < 2:
                    continue
                centre = shapes[index].representative_point()
                members.sort(key=lambda f: (math.dist(f['geometry']['coordinates'], (centre.x, centre.y)), f['properties']['source_row']))
                props = contours[index]['properties']
                groups.append({
                    'district': props.get('district') or slug, 'kind': kind, 'contour_id': props.get('id'),
                    'contour_name': props.get('parent_object_name', ''),
                    'keys': [f"{slug}:{f['properties']['source_row']}" for f in members],
                })
    OUT.write_text(json.dumps({'rule': 'одна площадка АСУ ОДС — одна точка фото', 'groups': groups},
                              ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(f'групп: {len(groups)}, лишних точек: {sum(len(g["keys"]) - 1 for g in groups)} → {OUT.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
