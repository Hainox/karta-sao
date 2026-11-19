"""Сводка для районов и реестры для проверки в Excel и ГИС."""
import csv
from collections import Counter
from shapely.geometry import shape

from build_preview import HERE, read


def register(name, headings, rows):
    with (HERE/'data'/name).open('w', encoding='utf-8-sig', newline='') as out:
        writer = csv.writer(out, delimiter=';')
        writer.writerow(headings)
        writer.writerows(rows)


def fmt(n):
    return f'{n:,}'.replace(',', ' ')


def export():
    dest = HERE/'data'
    report = read(dest/'summary.json')
    totals = report['total']
    old = read(HERE/'original-api.json')
    events = read(dest/'excluded.geojson')['features']
    review = read(dest/'review.geojson')['features']
    points = read(dest/'catalog.json')['points']
    chains = read(dest/'chainage.json')
    routes = read(dest/'routes.geojson')['features']
    types = {'dp':'Детская площадка','sp':'Спортивная площадка','park':'Парк'}
    scope = {'partial':'Часть дорожки','full':'Весь контур','point':'Исходная точка без контура дорожки'}
    for filename,features,cut in [('Исключения.csv',events,True),('Требуют сверки.csv',review,False)]:
        head = ['Район','ID дорожки','Причина']
        if cut:
            head += ['Тип территории','ID контура','Что пересекается']
        rows = []
        for f in features:
            p=f['properties']
            row=[p['district'],p['sourceId'],p['reason']]
            if cut:
                row += [types[p['kind']],p['maskId'],scope[p['scope']]]
            pt = shape(f['geometry']).representative_point()
            rows.append(row+[round(pt.y,7),round(pt.x,7)])
        register(filename,head+['Широта участка','Долгота участка'],sorted(rows))
    fields = [('old_points','Было точек'),('old_slots','Было кадров'),('old_multislot','Точек с несколькими кадрами'),
              ('new_points','Стало точек и кадров'),('retained','Сохранено позиций'),('moved','Перенесено'),
              ('removed','Выведено из плана'),('created','Добавлено'),('ambiguous_sources','Дорожек на сверку'),
              ('paths_park','Объектов у парков'),('paths_dp','У ДП'),('paths_sp','У СП'),
              ('long_points_per_km','Точек на км длинных осей'),('similar_before','Близких пар до'),('similar_after','Близких пар после')]
    names = sorted(report['districts'])
    register('Сводка по районам.csv',['Район']+[title for _,title in fields],
        [[name]+[r.get(k,0) for k,_ in fields] for name,r in
         [(n,report['districts'][n]) for n in names]+[('Всего',totals)]])
    groups = Counter(p['routeId'] for p in points)
    short = [p for p in routes if p['properties']['rule']=='short']
    single = sum(groups[r['properties']['routeId']]==1 for r in short)
    gaps = [v for r in chains for v in r['gaps_m']]
    park_count=len(read(HERE/'parks-osm.geojson')['features'])
    group_reason = {k:len({f['properties']['sourceId'] for f in events if f['properties']['kind']==k})
                    for k in types}
    md = ['# Оцифровка ДТС · рабочая схема от 19 ноября 2026 года','',
        '[Открыть карту](../review-map/index.html) · [Сводка по районам](Сводка%20по%20районам.csv) · [Исключения](Исключения.csv) · [Требуют сверки](Требуют%20сверки.csv)','',
        f"В исходном каталоге число точек — {fmt(totals['old_points'])}, число кадров — {fmt(totals['old_slots'])}. У {fmt(totals['old_multislot'])} точек было несколько направлений. В расчётном каталоге {fmt(len(points))} точек, у каждой один слот и один азимут. Снято с расчётного задания {fmt(totals['removed'])} прежних точек, добавлено {fmt(totals['created'])}. Координаты сохранены у {fmt(totals['retained'])} точек, изменены у {fmt(totals['moved'])}.",'',
        '| Район | Было точек | Было слотов | Стало точек и слотов | Перенесено | Убрано | Добавлено | Дорожек на сверку |',
        '|---|---:|---:|---:|---:|---:|---:|---:|']
    for name,r in [(n,report['districts'][n]) for n in names]+[('**САО**',totals)]:
        md.append('| '+ name+' | '+' | '.join(fmt(r.get(k,0)) for k in ['old_points','old_slots','new_points','moved','removed','created','ambiguous_sources'])+' |')
    md += ['', '## Основания для изменения задания','',
        f"Найдены контуры {fmt(report['matched_source_ids'])} из {fmt(report['source_ids'])} исходных дорожек АСУ ОДС. Для {report['source_ids']-report['matched_source_ids']} дорожек отсутствует геометрия. Их прежние позиции внесены в реестр сверки. Всего на сверке {fmt(totals['ambiguous_sources'])} объектов. Среди причин — расхождения контуров, касания, остатки у зданий, фрагменты без безопасной позиции и неполный расчётный охват.",'',
        f"Проверены полигоны ДП и СП районных слоёв и {park_count} открытых контуров парков OpenStreetMap, пересекающих САО. Реестр содержит пересечения {group_reason['park']} исходных объектов с парками, {group_reason['dp']} с ДП и {group_reason['sp']} со СП, включая точечные свидетельства при отсутствии геометрии. Один объект может встретиться в нескольких категориях. Для частичных пересечений сохранена оставшаяся доступная часть дорожки. При общей границе с площадкой используется ширина конкретной дорожки. Зазоры и точечные касания требуют отдельного решения.",'',
        '[Разбор геометрии и допущений](../Геометрия.md) · [Площадь отсечения по каждой дорожке](excluded-sources.json). Парки отобраны по замкнутым геометриям OSM с тегом leisure=park. Контуры и дата данных сохранены в [файле источника](../parks-osm.geojson). Новые или незанесённые парки, ограждения и растительность требуют проверки на местности. [© OpenStreetMap contributors, ODbL](https://www.openstreetmap.org/copyright)','',
        '## Геометрия и направления','',
        f"Для {fmt(totals['routes'])} участков восстановлены расчётные оси по полигональной геометрии. В расчёте {totals['rule_long']} длинных, {totals['rule_short']} коротких, {totals['rule_compact']} компактных и {totals['rule_branched']} разветвлённых участков. Для {fmt(single)} коротких участков предложен один кадр. В компактных зонах {fmt(totals['compact_perimeter_points'])} из {fmt(totals['compact_points'])} кадров запланированы с периметра.",'',
        f"Длина главных осей длинных участков — {totals['long_m']/1000:.2f} км. На них предложено {totals['long_points']} кадров, в среднем {totals['long_points_per_km']} на км с учётом поворотов и концов. Среди {len(gaps)} пар регулярных станций {sum(99.99<=g<=100.01 for g in gaps)} интервалов по 100 м. Максимальный промежуток с учётом проекций всех камер и обоих концов — {report['longest_gap_m']:.2f} м. Причины отклонений приведены в [ведомости расстояний](chainage.json).",'',
        f"Модель использует контрольные точки с интервалом до {report['sample_spacing_m']} м и горизонтальный угол кадра {report['horizontal_fov_deg']}°. Учитываются геометрия ветвей и известные препятствия. Из {fmt(totals['samples'])} контрольных позиций на тех же осях прежние допустимые ракурсы охватывают {fmt(totals['old_samples_same_routes'])}, расчётные — {fmt(totals['covered_samples'])}. У {fmt(totals['samples']-totals['covered_samples'])} контрольных позиций расчётный обзор остаётся неподтверждённым. Доступность точки для фотографа, обзор между деревьями и качество кадра подтверждаются на месте.",'',
        f"Пары направлений на расстоянии до 5 м и с расхождением до 10° проверены отдельно. Было {fmt(totals['similar_before'])}, стало {fmt(totals['similar_after'])}. Это кандидаты на повтор. [Список пар](similar-views.json)",'',
        '## Как проверить и что согласовать','',
        '1. Открыть карту, выбрать район и тип участка. Зелёные стрелки показывают расчётные кадры, фиолетовые — прежние. Оранжевым выделена исключённая геометрия. Клик по точке открывает координаты, ID кадра и азимут. Изменения на этой карте хранятся локально в браузере.',
        '2. Сверить спорные объекты с районными специалистами и официальными границами парков. Для видимости и безопасности позиции нужна натурная проверка.',
        '3. Перед переключением отдельно согласовать замену каталога и перенос изменений на рабочий сервис и районные карты. Сохранить резервную копию сервера, повторить сверку фотографий и ручных правок по актуальной БД и подготовить откат.',
        '',f"На момент чтения все слоты были пустыми. Окончание чтения в UTC — {old['finishedAt']}. История вне текущего API требует сверки с БД. [Условия переноса и отката](../photo-compatibility.md) · [Судьба каждой исходной точки](dispositions.json) · [Новый каталог](catalog.json)"]
    (dest/'Отчёт.md').write_text('\n'.join(md)+'\n',encoding='utf-8')


if __name__=='__main__':
    export()
