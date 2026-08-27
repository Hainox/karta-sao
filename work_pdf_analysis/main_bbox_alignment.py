import json, cv2, numpy as np
from pathlib import Path
from pyproj import Transformer
ROOT=Path(r'C:\Users\root\Downloads\КАРТА'); L=ROOT/'odh-map'/'layers'; OUT=ROOT/'work_pdf_analysis'
im=cv2.imread(r'C:\Users\root\Downloads\KARTA_page_1.png')
tr=Transformer.from_crs(4326,3857,always_xy=True)
def walk(g):
 c=g['coordinates'];t=g['type']
 if t=='Polygon':
  for r in c: yield from r
 elif t=='MultiPolygon':
  for p in c:
   for r in p: yield from r
 elif t=='Point':yield c
pts=[]
for n in ['sao_wave1_complete_wgs84.geojson','sao_remaining_wgs84.geojson']:
 for f in json.loads((L/n).read_text('utf8'))['features']:
  for p in walk(f['geometry']):
   lon,lat=p[:2]
   if not(lon<37.426 and lat>55.907):pts.append(tr.transform(lon,lat))
pts=np.array(pts); xmin,ymin=tr.transform(37.4364835,55.7598459);xmax,ymax=tr.transform(37.5886333,55.9075674)
# bbox map, source north ymax -> top y 355; source south ymin->bottom 1630
u=525+(pts[:,0]-xmin)/(xmax-xmin)*(1135-525)
v=355+(ymax-pts[:,1])/(ymax-ymin)*(1630-355)
for x,y in zip(u[::60].astype(int),v[::60].astype(int)):
 if 0<=x<im.shape[1] and 0<=y<im.shape[0]:cv2.circle(im,(x,y),1,(255,0,255),-1)
cv2.imencode('.png',im)[1].tofile(str(OUT/'main_bbox_alignment.png'))
