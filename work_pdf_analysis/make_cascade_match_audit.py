from pathlib import Path
import csv,json,html,re,difflib
ROOT=Path(r'C:\Users\root\Downloads\КАРТА');D=ROOT/'projects'/'odh-yandex-export'/'data';L=ROOT/'odh-map'/'layers';OUT=Path(r'C:\Users\root\DOWNLO~1\C8DC~1\projects\odh-yandex-export\outputs')
report=list(csv.DictReader((D/'owner_cascade_match_audit.csv').open(encoding='utf-8-sig')))
color={r['id']:r for r in csv.DictReader((D/'remaining_historical_pdf_color_review.csv').open(encoding='utf-8-sig'),delimiter=';')}
source=json.loads((L/'sao_remaining_wgs84.geojson').read_text('utf8'));byid={}
for f in source['features']:byid.setdefault(str(f['properties']['id']),f['properties']['name'])
def norm(s):
 s=s.lower().replace('ё','е').replace('—','-').replace('–','-').replace('№','').replace('ген.','генерала')
 s=re.sub(r'\([^)]*\)',' ',s);s=re.sub(r'\b(улица|ул\.?|переулок|пер\.?|проезд|пр\.?|шоссе|ш\.?|бульвар|бул\.?|владение|вл\.?)\b',' ',s);s=re.sub(r'[^0-9a-zа-я]+',' ',s)
 return ' '.join(s.split())
def score(a,b):
 aa,bb=set(norm(a).split()),set(norm(b).split());tok=2*len(aa&bb)/(len(aa)+len(bb)) if aa or bb else 0;seq=difflib.SequenceMatcher(None,norm(a),norm(b)).ratio();return max(tok,seq)
items=[r for r in report if r['match_mode'] in ('unmatched','duplicate')]
blocks=[]
for r in items:
 cand=sorted([(score(r['source_list_name'],n),i,n) for i,n in byid.items()],reverse=True)[:8]
 lis=''.join('<li><b>{:.0%}</b> — {} <span>ID {}; PDF: очередь {} · {}%</span></li>'.format(sc,html.escape(n),html.escape(i),html.escape(color[i]['old_queue_candidate'] or 'нет'),round(float(color[i]['confidence'])*100)) for sc,i,n in cand)
 blocks.append('<article><h2>Задано: очередь {} — {}</h2><p>Автосопоставление: {}; текущий ID: {}</p><ol>{}</ol></article>'.format(r['source_list_queue'],html.escape(r['source_list_name']),r['match_mode'],html.escape(r['matched_id']),lis))
page='''<!doctype html><meta charset="utf-8"><title>Сверка каскада — неоднозначные совпадения</title><style>body{font:16px Arial;max-width:1000px;margin:30px auto;background:#f7f5ef;color:#112d40}article{background:#fff;border:1px solid #d6e1e5;border-radius:10px;padding:12px 18px;margin:12px 0}h2{font-size:18px;margin:0}span{color:#63727a;font-family:monospace}li{margin:7px 0}p{color:#63727a}</style><h1>Неоднозначные позиции из каскада</h1><p>Показаны только позиции, которые нельзя безопасно присвоить автоматически. «PDF» — самостоятельная проверка цветовой разметки старой карты.</p>'''+''.join(blocks)
(OUT/'odh_каскад_неоднозначные_сопоставления.html').write_text(page,encoding='utf8')
