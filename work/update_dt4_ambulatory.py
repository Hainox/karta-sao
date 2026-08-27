from pathlib import Path
import json
import requests

ROOT = Path(r'C:\Users\root\Downloads\КАРТА')
WAYS = (61157810, 61157808)
headers = {'User-Agent': 'SAO-map-research/1.0 (public planning map)'}
buildings = []
for way_id in WAYS:
    data = requests.get(f'https://www.openstreetmap.org/api/0.6/way/{way_id}/full', headers=headers, timeout=30).text
    import xml.etree.ElementTree as ET
    root = ET.fromstring(data)
    nodes = {node.attrib['id']: (float(node.attrib['lon']), float(node.attrib['lat'])) for node in root.findall('node')}
    way = root.find('way')
    buildings.append([nodes[n.attrib['ref']] for n in way.findall('nd')])

# The displayed outline is deliberately a planning envelope joining two actual
# building references. It is not a cadastral/ASU ODS courtyard contour.
pts = [p for ring in buildings for p in ring]
minx, maxx = min(p[0] for p in pts), max(p[0] for p in pts)
miny, maxy = min(p[1] for p in pts), max(p[1] for p in pts)
pad_x, pad_y = 0.00009, 0.000075
envelope = [[minx-pad_x,miny-pad_y],[maxx+pad_x,miny-pad_y],[maxx+pad_x,maxy+pad_y],[minx-pad_x,maxy+pad_y],[minx-pad_x,miny-pad_y]]

path = ROOT/'smm.geojson'
data = json.loads(path.read_text(encoding='utf-8'))
data['features'] = [f for f in data['features'] if f.get('id') != 'smm-dt4']
data['features'].append({
  'type':'Feature', 'id':'smm-dt4',
  'properties': {
    'district':'Аэропорт', 'section':'Участок уточняется',
    'name':'ДТ-4 «Два корпуса» — маршрут СММ',
    'address':'1-й Амбулаторный проезд, д. 5, к. 1 и к. 2',
    'scheme':'smm/dt4.svg','detail':'smm/#dt4',
    'status':'Адреса подтверждены по картографической привязке',
    'storage':'Н-4 — место назначает ответственный после осмотра',
    'passes':'Челночная обработка между двумя корпусами; количество проходов — по натурному замеру',
    'note':'Рабочая схема по двум корпусам. Контур на обзорной карте — планировочный, построен по адресным точкам зданий из OpenStreetMap; не является паспортом АСУ ОДС.',
    'source':'OpenStreetMap, ways 61157810 and 61157808; retrieved 2026-08-27',
    'geometry_status':'Планировочная привязка по адресам; требуется сверка ответственным',
    'retrieved_at':'2026-08-27'
  },
  'geometry':{'type':'Polygon','coordinates':[envelope]}
})
data['metadata']['feature_count'] = len(data['features'])
data['metadata']['updated_at'] = '2026-08-27'
path.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8')

html = (ROOT/'smm'/'index.html').read_text(encoding='utf-8')
html = html.replace('ДТ-4 · «Г-образный»', 'ДТ-4 · «Два корпуса»')
html = html.replace('Два перпендикулярных плеча с поворотом маршрута', 'Межкорпусный проезд и два параллельных фасада')
html = html.replace('Клязьминская ул., д. 5, к. 1 · Дмитровский', '1-й Амбулаторный пр-д, д. 5, к. 1 и к. 2 · Аэропорт')
html = html.replace('<tr><td>ДТ-4 «Г-образный»</td><td>Клязьминская ул., д. 5, к. 1</td><td>Дмитровский</td>\n              <td>Два перпендикулярных плеча; маршрут строится с последовательным переходом через поворот</td></tr>', '<tr><td>ДТ-4 «Два корпуса»</td><td>1-й Амбулаторный пр-д, д. 5, к. 1 и к. 2</td><td>Аэропорт</td>\n              <td>Межкорпусный проезд; челночная обработка от одного фасада к другому</td></tr>')
old = """dt4: {
      code:'ДТ-4', name:'«Г-образный» — двор с двумя перпендикулярными плечами',
      addr:'Клязьминская ул., д. 5, к. 1', district:'Дмитровский',
      center:[37.51991140,55.88701293], scheme:'dt4.svg',
      cap:'ДТ-4 «Г-образный». Рабочая схема: последовательно пройти первое плечо, выполнить безопасный поворот и обработать второе плечо. Направление выброса и место складирования определяются после натурного осмотра.',
      facts:[
        ['Вариант','В-4 · последовательная обработка плеч'],
        ['Машина','СММ — по закреплению участка'],
        ['Проходов','Уточняются по натурному замеру'],
        ['Манёвр','Поворот только на свободной площадке'],
        ['Направление выброса','Определяется после осмотра'],
        ['Складирование','Н-4 · место утверждает ответственный'],
        ['Статус контура','<span class="pill ok">АСУ ОДС</span>'],
        ['Статус маршрута','<span class="pill warn">Требует утверждения</span>']
      ]
    }"""
new = """dt4: {
      code:'ДТ-4', name:'«Два корпуса» — межкорпусный маршрут',
      addr:'1-й Амбулаторный пр-д, д. 5, к. 1 и к. 2', district:'Аэропорт',
      center:[37.5351038,55.8109680], scheme:'dt4.svg',
      cap:'ДТ-4 «Два корпуса». Рабочая схема: челночные проходы в межкорпусном проезде с контролем свободного разворота. Направление выброса и место складирования определяются после натурного осмотра.',
      facts:[
        ['Вариант','В-4 · межкорпусный челнок'],
        ['Машина','СММ — по закреплению участка'],
        ['Проходов','Уточняются по натурному замеру'],
        ['Манёвр','Разворот только на свободной площадке'],
        ['Направление выброса','Определяется после осмотра'],
        ['Складирование','Н-4 · место утверждает ответственный'],
        ['Статус привязки','<span class="pill warn">Требует сверки участка</span>'],
        ['Статус маршрута','<span class="pill warn">Требует утверждения</span>']
      ]
    }"""
if old not in html:
    raise RuntimeError('DT-4 block was not found; no partial replacement made')
(ROOT/'smm'/'index.html').write_text(html.replace(old,new),encoding='utf-8')
print('DT-4 updated:', len(buildings), 'building footprints; center', [37.5351038,55.8109680])
