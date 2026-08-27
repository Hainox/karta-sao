import csv,json,cv2,numpy as np
from pathlib import Path
from pyproj import Transformer
ROOT=Path(r'C:\Users\root\Downloads\КАРТА');L=ROOT/'odh-map'/'layers';D=ROOT/'projects'/'odh-yandex-export'/'data';W=ROOT/'work_pdf_analysis'
rows=list(csv.DictReader((D/'current_wave1_historical_pdf_review.csv').open(encoding='utf-8-sig'),delimiter=';'));q={x['id']:x['old_queue_candidate'] for x in rows}
im=cv2.imdecode(np.fromfile(W/'page_1.png',dtype=np.uint8),cv2.IMREAD_COLOR);tr=Transformer.from_crs(4326,3857,always_xy=True)
MAIN=(37.4364835,55.7598459,37.5886333,55.9075674,525,355,1135,1630);INSET=(37.3313205,55.9081959,37.4224581,55.9572896,118,32,612,525)
def pix(lon,lat):
 x,y=tr.transform(lon,lat); a=INSET if lon<37.426 and lat>55.907 else MAIN;mnlo,mnla,mxlo,mxla,x0,y0,x1,y1=a; xmin,ymin=tr.transform(mnlo,mnla);xmax,ymax=tr.transform(mxlo,mxla);return round(x0+(x-xmin)/(xmax-xmin)*(x1-x0)),round(y0+(ymax-y)/(ymax-ymin)*(y1-y0))
def pts(g):
 c=g['coordinates'];t=g['type']
 if t=='Polygon':
  for r in c:
   for p in r:yield p
 elif t=='Point':yield c
by={}
for f in json.loads((L/'sao_wave1_complete_wgs84.geojson').read_text(encoding='utf8'))['features']:
 p=f['properties'];id=str(p['id']);a=list(pts(f['geometry']));
 if a:
  lon=sum(x[0] for x in a)/len(a);lat=sum(x[1] for x in a)/len(a);by.setdefault(id,[]).append((lon,lat))
colors={'1':(30,30,230),'2':(180,50,10),'3':(40,185,45),'':(55,55,55)}
for id,centers in by.items():
 lon=sum(x[0] for x in centers)/len(centers);lat=sum(x[1] for x in centers)/len(centers);x,y=pix(lon,lat);col=colors.get(q.get(id,''),colors['']);cv2.circle(im,(x,y),5,(255,255,255),-1);cv2.circle(im,(x,y),4,col,-1)
cv2.imencode('.png',im)[1].tofile(str(W/'current_wave1_pdf_candidate_centroids.png'))
