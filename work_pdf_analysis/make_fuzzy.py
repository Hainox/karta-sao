from pathlib import Path
import csv,html
D=Path(r'C:\Users\root\Downloads\КАРТА\projects\odh-yandex-export\data');O=Path(r'C:\Users\root\DOWNLO~1\C8DC~1\projects\odh-yandex-export\outputs')
r=list(csv.DictReader((D/'owner_cascade_match_audit.csv').open(encoding='utf-8-sig')))
a=[x for x in r if x['match_mode']=='fuzzy']
body=''.join('<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>'.format(html.escape(x['source_list_queue']),html.escape(x['source_list_name']),html.escape(x['matched_id']),html.escape(x['matched_name']),html.escape(x['match_score'])) for x in a)
(O/'odh_каскад_нечеткие_совпадения.html').write_text('<meta charset=utf8><style>body{font:16px Arial}td,th{padding:8px;border:1px solid #ccc;text-align:left}table{border-collapse:collapse}</style><h1>Нечёткие совпадения</h1><table><tr><th>Очередь</th><th>Из списка</th><th>ID</th><th>Наименование реестра</th><th>Оценка</th></tr>'+body+'</table>',encoding='utf8')
