from __future__ import annotations
import json, math
from pathlib import Path
import cv2
import numpy as np
from pyproj import Transformer
from scipy.optimize import differential_evolution

ROOT=Path(r'C:\Users\root\Downloads\КАРТА')
IMG=Path(r'C:\Users\root\Downloads\KARTA_page_1.png')
LAYERS=ROOT/'odh-map'/'layers'
OUT=ROOT/'work_pdf_analysis'
OUT.mkdir(exist_ok=True)

def coords(g):
    t=g.get('type'); c=g.get('coordinates')
    if t=='Polygon':
        for r in c:
            yield from r
    elif t=='MultiPolygon':
        for p in c:
            for r in p: yield from r
    elif t=='LineString': yield from c
    elif t=='Point': yield c

def load_points(files, only_main=True):
    tr=Transformer.from_crs(4326,3857,always_xy=True)
    pts=[]
    for f in files:
        d=json.loads((LAYERS/f).read_text('utf8'))
        for ft in d['features']:
            for lon,lat,*_ in coords(ft['geometry']):
                # historical main section does not contain Molzhaninovsky inset
                if only_main and lon < 37.426 and lat > 55.907:
                    continue
                x,y=tr.transform(lon,lat); pts.append((x,y))
    arr=np.asarray(pts,dtype=np.float32)
    # deterministic downsample
    return arr[::max(1,len(arr)//6000)]

im=cv2.imread(str(IMG))
hsv=cv2.cvtColor(im,cv2.COLOR_BGR2HSV)
# Road/corridor colours incl. three historical queues and ordinary orange road context.
# Restrict saturation/value to reject white background; legend masked out explicitly.
mask=np.zeros(hsv.shape[:2],np.uint8)
ranges=[((0,45,80),(10,255,255)),((170,45,80),(179,255,255)),((90,45,70),(130,255,255)),((38,35,70),(85,255,255)),((12,45,100),(32,255,255))]
for lo,hi in ranges:
    mask|=cv2.inRange(hsv,np.array(lo),np.array(hi))
# remove legend and table; retain only map sections
mask[:, :500]=0
# morphological one-pixel dilate makes anti-aliased PDF road strokes usable
mask=cv2.dilate(mask,np.ones((3,3),np.uint8),iterations=1)
# distance to a coloured-road pixel
D=cv2.distanceTransform(255-mask,cv2.DIST_L2,3)
pts=load_points(['sao_wave1_complete_wgs84.geojson','sao_remaining_wgs84.geojson'])
center=pts.mean(0); q=pts-center
# only boundaries/vertices, use lots. Transform parameterized around approximate page location
H,W=mask.shape

def score(z, detail=False):
    sx,sy,rot,tx,ty=z
    co,si=math.cos(rot),math.sin(rot)
    # y should flip geographically, sy supplied negative
    u=sx*(q[:,0]*co-q[:,1]*si)+tx
    v=sy*(q[:,0]*si+q[:,1]*co)+ty
    valid=(u>=0)&(u<W)&(v>=0)&(v<H)
    if valid.mean()<.7: return 1e6
    di=D[v[valid].astype(int),u[valid].astype(int)]
    # Reward vicinity to coloured map lines. Huber-like cap prevents outliers.
    val=-np.mean(np.exp(-di/3.5))
    if detail:return val,valid.mean(),np.median(di),np.mean(di<3)
    return val
# Source center approx should land central body at image x~820,y~960.
bounds=[(.020,.055),(-.055,-.020),(-.08,.08),(720,930),(800,1150)]
res=differential_evolution(score,bounds,seed=17,popsize=8,maxiter=12,tol=1e-5,workers=1,polish=True,updating='immediate')
print('result',res.fun,res.x,score(res.x,True))
# save parameters + diagnostic overlay of 3k transformed source vertices
z=res.x; sx,sy,rot,tx,ty=z;co,si=math.cos(rot),math.sin(rot)
u=sx*(q[:,0]*co-q[:,1]*si)+tx;v=sy*(q[:,0]*si+q[:,1]*co)+ty
ov=im.copy()
valid=(u>=0)&(u<W)&(v>=0)&(v<H)
for x,y in zip(u[valid][::15].astype(int),v[valid][::15].astype(int)):
    cv2.circle(ov,(x,y),1,(255,0,255),-1)
cv2.imencode('.png',ov)[1].tofile(str(OUT/'main_alignment_diagnostic.png'))
(OUT/'main_alignment_params.json').write_text(json.dumps({'center_3857':center.tolist(),'params':res.x.tolist(),'metric':[float(x) for x in score(res.x,True)]},indent=2),encoding='utf8')


