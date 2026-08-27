import json,cv2,numpy as np
from pathlib import Path
from pyproj import Transformer
ROOT=Path(r'C:\Users\root\Downloads\КАРТА');L=ROOT/'odh-map'/'layers';OUT=ROOT/'work_pdf_analysis';im=cv2.imread(r'C:\Users\root\Downloads\KARTA_page_1.png');tr=Transformer.from_crs(4326,3857,always_xy=True)
def walk(g):
 c=g['coordinates'];t=g['type']
 if t=='Polygon':
  for r in c:yield from r
 elif t=='MultiPolygon':
  for p in c:
   for r in p:yield from r
 elif t=='Point':yield c
pts=[]
for n in ['sao_wave1_complete_wgs84.geojson','sao_remaining_wgs84.geojson']:
 for f in json.loads((L/n).read_text('utf8'))['features']:
  for p in walk(f['geometry']):
   lon,lat=p[:2]
   if lon<37.426 and lat>55.907:pts.append(tr.transform(lon,lat))
pts=np.array(pts);xmin,ymin=tr.transform(37.3313205,55.9081959);xmax,ymax=tr.transform(37.4224581,55.9572896)
u=118+(pts[:,0]-xmin)/(xmax-xmin)*(612-118);v=32+(ymax-pts[:,1])/(ymax-ymin)*(525-32)
for x,y in zip(u[::20].astype(int),v[::20].astype(int)):
 if 0<=x<im.shape[1] and 0<=y<im.shape[0]:cv2.circle(im,(x,y),1,(255,0,255),-1)
cv2.imencode('.png',im)[1].tofile(str(OUT/'inset_bbox_alignment.png'))
