from pathlib import Path
import json
import xml.etree.ElementTree as ET

import requests

ROOT = Path(r'C:\Users\root\Downloads\КАРТА')
WAY_ID = 53219820
headers = {'User-Agent': 'SAO-map-research/1.0 (public planning map)'}
xml = requests.get(f'https://www.openstreetmap.org/api/0.6/way/{WAY_ID}/full', headers=headers, timeout=30).text
root = ET.fromstring(xml)
nodes = {node.attrib['id']: [float(node.attrib['lon']), float(node.attrib['lat'])] for node in root.findall('node')}
way = root.find('way')
ring = [nodes[node.attrib['ref']] for node in way.findall('nd')]
if ring[0] != ring[-1]:
    ring.append(ring[0])

geo_path = ROOT / 'smm.geojson'
data = json.loads(geo_path.read_text(encoding='utf-8'))
data['features'] = [feature for feature in data['features'] if feature.get('id') != 'smm-dt5']
data['features'].append({
    'type': 'Feature', 'id': 'smm-dt5',
    'properties': {
        'district': 'Войковский',
        'section': 'Участок уточняется',
        'name': 'ДТ-5 «Полукольцо» — маршрут СММ',
        'address': 'Старопетровский проезд, д. 10Б',
        'scheme': 'smm/dt5.svg', 'detail': 'smm/#dt5',
        'status': 'Адрес подтверждён картографической привязкой',
        'storage': 'Н-5 — место назначает ответственный после осмотра',
        'passes': 'Дуговой проход по внутреннему проезду с разворотом на свободной площадке',
        'note': 'Рабочая схема составлена по адресу и видимой конфигурации проездов. Не является паспортом территории или утверждённой технологической картой.',
        'source': 'OpenStreetMap way 53219820; retrieved 2026-08-27',
        'geometry_status': 'Планировочная привязка по адресу; требует натурной сверки и утверждения',
        'retrieved_at': '2026-08-27',
    },
    'geometry': {'type': 'Polygon', 'coordinates': [ring]},
})
data['metadata']['feature_count'] = len(data['features'])
data['metadata']['updated_at'] = '2026-08-27'
geo_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

page_path = ROOT / 'smm' / 'index.html'
page = page_path.read_text(encoding='utf-8')
button = '''      <button type="button" class="yard" data-yard="dt5" aria-pressed="false">
        <span class="code">ДТ-5 · «Полукольцо»</span>
        <div class="ttl">Дуговой внутренний проезд вокруг здания</div>
        <div class="addr">Старопетровский проезд, д. 10Б · Войковский</div>
      </button>
'''
page = page.replace('      <button type="button" class="teaser-more"', button + '      <button type="button" class="teaser-more"')
row = '''          <tr><td>ДТ-5 «Полукольцо»</td><td>Старопетровский проезд, д. 10Б</td><td>Войковский</td>
              <td>Дуговой внутренний проезд вокруг здания; последовательный обход без выброса на посадки</td></tr>
'''
page = page.replace('        </table>\n        <div class="flag"><b>Статус привязки.</b>', row + '        </table>\n        <div class="flag"><b>Статус привязки.</b>')
end = """    }
  };

  var current = 'dt1';"""
addition = """    },
    dt5: {
      code:'ДТ-5', name:'«Полукольцо» — дуговой внутренний проезд',
      addr:'Старопетровский проезд, д. 10Б', district:'Войковский',
      center:[37.5087126,55.8229632], scheme:'dt5.svg',
      cap:'ДТ-5 «Полукольцо». Рабочая схема: последовательный дуговой проход по внутреннему проезду; разворот выполняется только на свободной площадке. Направление выброса и место складирования определяются после натурного осмотра.',
      facts:[
        ['Вариант','В-5 · дуговой обход'],
        ['Машина','СММ — по закреплению участка'],
        ['Проходов','Уточняются по натурному замеру'],
        ['Манёвр','Разворот только на свободной площадке'],
        ['Направление выброса','Определяется после осмотра'],
        ['Складирование','Н-5 · место утверждает ответственный'],
        ['Статус привязки','<span class="pill warn">Требует сверки участка</span>'],
        ['Статус маршрута','<span class="pill warn">Требует утверждения</span>']
      ]
    }
  };

  var current = 'dt1';"""
if end not in page:
    raise RuntimeError('End of YARDS configuration not found')
page_path.write_text(page.replace(end, addition), encoding='utf-8')

svg = '''<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="680" viewBox="0 0 1000 680"><defs><marker id="r" markerWidth="12" markerHeight="12" refX="9" refY="4" orient="auto"><path d="M0 0L0 8L10 4z" fill="#e00000"/></marker><pattern id="g" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="12" height="12" fill="#a6cf96"/><path d="M0 0V12" stroke="#87b678" stroke-width="2"/></pattern><pattern id="s" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="14" height="14" fill="#d7eaf6"/><path d="M0 0V14" stroke="#a0c5dd" stroke-width="2"/></pattern></defs><rect width="1000" height="680" fill="#f7f9fb"/><rect x="46" y="45" width="908" height="525" fill="#93989d" stroke="#798087" stroke-width="2"/><path d="M170 133 Q510 52 800 155 L800 340 Q701 497 478 502 Q236 498 151 334 Z" fill="url(#g)" stroke="#69815f" stroke-width="2"/><path d="M211 177 Q508 109 750 189 L750 315 Q672 442 480 451 Q285 442 207 309 Z" fill="#e6e9ec" stroke="#aeb8be" stroke-width="2"/><path d="M353 205 Q504 158 649 210 L649 359 Q503 404 351 355 Z" fill="#c7cdd1" stroke="#8c959c" stroke-width="3"/><text x="501" y="286" text-anchor="middle" font-family="Arial" font-size="17" font-weight="700" fill="#53606a">здание · Старопетровский пр-д, 10Б</text><rect x="724" y="365" width="110" height="82" fill="url(#s)" stroke="#5b97bc" stroke-width="2"/><rect x="750" y="392" width="58" height="27" rx="6" fill="#fff" stroke="#5b97bc" stroke-width="2"/><text x="779" y="412" text-anchor="middle" font-family="Arial" font-size="15" font-weight="700" fill="#176395">Н-5</text><g fill="#9dbc76" stroke="#63864f" stroke-width="2"><circle cx="245" cy="170" r="25"/><circle cx="744" cy="170" r="25"/><circle cx="194" cy="314" r="25"/><circle cx="772" cy="332" r="25"/><circle cx="291" cy="450" r="25"/></g><g fill="none" stroke="#e00000" stroke-width="6" stroke-linecap="round"><path d="M236 228 Q487 137 742 232" marker-end="url(#r)"/><path d="M747 245 Q533 443 242 316" marker-end="url(#r)"/><path d="M249 329 Q463 470 728 338" marker-end="url(#r)"/></g><g stroke="#fff" stroke-width="1.3" stroke-dasharray="6 5"><path d="M236 228 Q487 137 742 232"/><path d="M747 245 Q533 443 242 316"/><path d="M249 329 Q463 470 728 338"/></g><g font-family="Arial" font-size="16" font-weight="700" text-anchor="middle"><circle cx="402" cy="188" r="16" fill="#0f71da" stroke="#fff" stroke-width="3"/><text x="402" y="194" fill="#fff">1</text><circle cx="553" cy="386" r="16" fill="#0f71da" stroke="#fff" stroke-width="3"/><text x="553" y="392" fill="#fff">2</text><circle cx="470" cy="432" r="16" fill="#0f71da" stroke="#fff" stroke-width="3"/><text x="470" y="438" fill="#fff">3</text></g><text x="496" y="532" text-anchor="middle" font-family="Arial" font-size="15" font-weight="700" fill="#35434c">последовательный обход дугового проезда</text><path d="M85 536H185M85 529V543M185 529V543" stroke="#111" stroke-width="3"/><text x="135" y="524" text-anchor="middle" font-family="Arial" font-size="12">10 м</text><text x="46" y="616" font-family="Arial" font-size="21" font-weight="700" fill="#18242c">ДТ-5 «Полукольцо». СММ проходит по дуге внутреннего проезда; снег не направляется на посадки.</text><text x="46" y="646" font-family="Arial" font-size="15" fill="#5a6871">Схема предварительная: место Н-5, параметры сопла и разворот подтверждаются ответственным участка до выхода техники.</text></svg>'''
(ROOT / 'smm' / 'dt5.svg').write_text(svg, encoding='utf-8')
print('DT-5 added at Старопетровский проезд, 10Б')
