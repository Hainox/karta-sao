from __future__ import annotations
import json,re,csv,difflib
from pathlib import Path
from collections import defaultdict,Counter
ROOT=Path(r'C:\Users\root\Downloads\КАРТА');L=ROOT/'odh-map'/'layers';D=ROOT/'projects'/'odh-yandex-export'/'data'
# Authoritative cascade supplied by the project owner on 26.08.2026.
WAVE1='''Ангарская ул. · Полтавская ул. · Молжаниновская ул. · Лобненская ул. · Синявинская ул. · ул. Лавочкина (Ховрино) · Краснополянская ул. · Ижорская ул. · Левобережная ул. · Головинское ш. · Беломорская ул. · Вагоноремонтная ул. · Проектируемый пр. №6176 · Проезд вдоль Ленинградского ш. (Колпинская) · Клязьминская ул. · Развязка МКАД-77км · Астрадамский пр. · ул. Вучетича · 4-й Вятский пер. · Проезд от Астрадамской до Вучетича · Дмитровский пр. · Проектируемый пр. №6175 · Охтинская ул. · Проезд от Левобережной до Дыбенко · ул. 800-летия Москвы · ул. Адмирала Макарова · ул. Дыбенко · Охтинский пр. · Улица Ген. Рычагова · Комсомольская ул. · Коровинский пр. · Пасечная ул. · Солнечногорская ул. · Солнечногорский пр. · переулок 800-летия Москвы · пр. Соломенной Сторожки · ул. Бусиновская Горка · ул. Розанова · 1-я Квесисская ул. · 1-я ул. Новосёлки · 4-й Лихачевский пер. · 5-я Магистральная ул. · Ижорский пр. · Клинский пр. · Краснополянская вл.10 (пр. к Мясопрому) · Новая ул. · Проезд к промзоне Новоподрезково · Проезд от Ленингр. ш. до реки Клязьмы · Проезд Михалковская—3-й Новомихалк. · Проезд Петрозаводская—Зеленоградская · Проезд от Прибрежного до МКАД · Проезд Базовская 3с1—15к11 · Проезд Дегунинская—Коровинское ш. · Проезды Ленинградская—1-я Сестрорецкая · Проектируемый пр. №8095 · Фестивальная ул. подъезд к 8с2'''
WAVE3='''1-й Красноармейский пер. · 1-й Лихачёвский пер. · 1-я Подрезковская ул. · 2-й Магистральный пр. · 2-я Подрезковская ул. · 3-й Новомихалковский пр. · 3-й Хорошевский пр. · 3-я Песчаная ул. · 4-й Новоподмосковный пер. · Авиаконструктора Микояна 14 (у Ходынки/ЦСКА) · Ильменский пр. · Красностуденческий пр. · Ленинградское ш. д.362А · Малый Песчаный пер. · Николая Рериха ул. · Новомихалковский 4-й пр. · Пакгаузное ш. · Петрозаводская ул. · Подъезд к ГАИ (Хорошевское ш.40) · Проезд Аэропорта · Проезд к МВД (Коптево) · Проезд от Комсомольской к ТП · Проезд от Кронштадтского бул. до церкви · Проезд от Левобережной до МКАД · Проезд Ленинградское ш.—3-я Сестрорецкая · Проезд от Нарвской до Водного стадиона · Проезд от Ходынского бул. к ЖК Лайнер · Проезд от Хорошевского ш. к ЖК Династия · Проезд от Адмирала Макарова до ЛТП · Пяловская вл.3 (стоянка) · Пяловская ул. · ТПУ ЦСКА Жилищник Хорошевский · Территория вокруг Академии хорового искусства · Территория у метро Полежаевская · Тротуар вдоль Головинских прудов · Улица Верещагина · Улица Дубки · Улица Маргелова · Улица Маршала Федоренко · Часовая ул. · боковой проезд Ленинградское ш.64-88 · местный проезд к Ледовому дворцу · проезд Черепановых · ул. Зои и Александра Космодемьянских · ул. Клары Цеткин · ул. Лихоборские Бугры'''
def items(s):return [x.strip() for x in s.split(' · ') if x.strip()]
def norm(s):
 s=s.lower().replace('ё','е').replace('—','-').replace('–','-').replace('№','').replace('ген.','генерала')
 s=re.sub(r'\([^)]*\)',' ',s)
 s=re.sub(r'\b(улица|ул\.?|переулок|пер\.?|проезд|пр\.?|шоссе|ш\.?|бульвар|бул\.?|владение|вл\.?)\b',' ',s)
 s=re.sub(r'[^0-9a-zа-я]+',' ',s)
 return ' '.join(s.split())
source=json.loads((L/'sao_remaining_wgs84.geojson').read_text(encoding='utf8'))
byid={}
for f in source['features']:
 p=f['properties'];byid.setdefault(str(p['id']),p['name'])
by_norm=defaultdict(list)
for ident,name in byid.items():by_norm[norm(name)].append((ident,name))
def match(item):
 n=norm(item)
 if n in by_norm and len(by_norm[n])==1:return (*by_norm[n][0],'exact',1.0)
 # token containment after abbreviations; only auto-accept a single candidate.
 toks=set(n.split());cand=[]
 for ident,name in byid.items():
  nn=norm(name);nt=set(nn.split()); common=len(toks&nt)
  ratio=2*common/(len(toks)+len(nt)) if toks or nt else 0
  seq=difflib.SequenceMatcher(None,n,nn).ratio()
  score=max(ratio,seq)
  if score>=.55:cand.append((score,ident,name))
 cand.sort(reverse=True)
 if cand and (len(cand)==1 or cand[0][0]-cand[1][0]>=.12):return (cand[0][1],cand[0][2],'fuzzy',round(cand[0][0],3))
 return ('','', 'unmatched',round(cand[0][0],3) if cand else 0)
assigned={}; report=[]
for queue,seq in [('1',items(WAVE1)),('3',items(WAVE3))]:
 for item in seq:
  ident,name,mode,score=match(item)
  if ident in assigned:mode='duplicate'
  if ident and mode!='duplicate':assigned[ident]=queue
  report.append({'source_list_queue':queue,'source_list_name':item,'matched_id':ident,'matched_name':name,'match_mode':mode,'match_score':score})
# write non-mutating audit; queue 2 remains all IDs not selected above.
for ident in byid:
 assigned.setdefault(ident,'2')
assert len(assigned)==len(byid)==591
out=D/'owner_cascade_match_audit.csv'
with out.open('w',newline='',encoding='utf-8-sig') as f:
 w=csv.DictWriter(f,fieldnames=list(report[0]));w.writeheader();w.writerows(report)
(D/'owner_cascade_queue_assignment.json').write_text(json.dumps({'source':'Owner-supplied cascade 2026-08-26','total':591,'counts':dict(Counter(assigned.values())),'assignments':assigned},ensure_ascii=False,indent=2),encoding='utf8')
print('source items',len(items(WAVE1)),len(items(WAVE3)))
print('assigned',Counter(assigned.values()))
print('match modes',Counter(r['match_mode'] for r in report))
for r in report:
 if r['match_mode'] not in ('exact','fuzzy'):print('CHECK',r)
