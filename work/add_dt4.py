from pathlib import Path
import json, os, math, requests
ROOT=Path(r'C:\Users\root\Downloads\КАРТА'); TYPE=38; OID=130011929200038
A=6377397.155; E2=.006674372230614; LAT0=55.66666666667; LON0=37.5
def arc(phi):
 return A*((1-E2/4-3*E2**2/64-5*E2**3/256)*phi-(3*E2/8+3*E2**2/32+45*E2**3/1024)*math.sin(2*phi)+(15*E2**2/256+45*E2**3/1024)*math.sin(4*phi)-(35*E2**3/3072)*math.sin(6*phi))
def conv(c):
 x,y=map(float,c); m=arc(math.radians(LAT0))+y; mu=m/(A*(1-E2/4-3*E2**2/64-5*E2**3/256)); e1=(1-math.sqrt(1-E2))/(1+math.sqrt(1-E2)); fp=mu+(3*e1/2-27*e1**3/32)*math.sin(2*mu)+(21*e1**2/16-55*e1**4/32)*math.sin(4*mu)+(151*e1**3/96)*math.sin(6*mu)+(1097*e1**4/512)*math.sin(8*mu)
 sp,cp,tp=math.sin(fp),math.cos(fp),math.tan(fp); cc=E2/(1-E2)*cp*cp;n=A/math.sqrt(1-E2*sp*sp);r=A*(1-E2)/(1-E2*sp*sp)**1.5;d=x/n
 lat=fp-(n*tp/r)*(d*d/2-(5+3*tp*tp+10*cc-4*cc*cc-9*E2/(1-E2))*d**4/24+(61+90*tp*tp+298*cc+45*tp**4-252*E2/(1-E2)-3*cc*cc)*d**6/720);lon=math.radians(LON0)+(d-(1+2*tp*tp+cc)*d**3/6+(5-2*cc+28*tp*tp-3*cc*cc+8*E2/(1-E2)+24*tp**4)*d**5/120)/cp
 bf=1/299.1528128;be2=2*bf-bf*bf;sl,cl=math.sin(lat),math.cos(lat);N=A/math.sqrt(1-be2*sl*sl);bx=N*cl*math.cos(lon);by=N*cl*math.sin(lon);bz=N*(1-be2)*sl;rx,ry,rz=[math.radians(v/3600) for v in(-.8777,1.3231,2.6248)];scale=1+8.96e-6;wx=367.93+scale*bx-rz*by+ry*bz;wy=88.45+rz*bx+scale*by-rx*bz;wz=553.73-ry*bx+rx*by+scale*bz;wa=6378137.;we2=6.6943799901413165e-3;p=math.hypot(wx,wy);lw=math.atan2(wz,p*(1-we2))
 for _ in range(8): ss=math.sin(lw);lw=math.atan2(wz+we2*(wa/math.sqrt(1-we2*ss*ss))*ss,p)
 return [math.degrees(math.atan2(wy,wx)),math.degrees(lw)]
def trans(v): return conv(v) if isinstance(v,list) and len(v)==2 and all(isinstance(x,(int,float)) for x in v) else [trans(x) for x in v]
base='https://reestr-ogh.mos.ru';api=base+'/api';h={'User-Agent':'Mozilla/5.0 SAO-SMM/1.0','Accept':'application/json','Origin':base,'Referer':base+'/r/ogh/odh'};s=requests.Session();s.get(base+'/auth/login',headers=h,timeout=30);s.post(api+'/login',headers={**h,'Content-Type':'application/x-www-form-urlencoded'},data={'username':os.environ['ODS_USERNAME'],'password':os.environ['ODS_PASSWORD'],'j_username':os.environ['ODS_USERNAME'],'j_password':os.environ['ODS_PASSWORD']},timeout=30).raise_for_status();r=s.get(api+'/ogh/geometry/full',params={'id':OID,'root_id':OID,'type_id':TYPE},headers=h,timeout=120);r.raise_for_status();objs=r.json() or [];polys=[]
for o in objs:
 for q in o.get('polygons') or []:
  co=q.get('coordinates') if isinstance(q,dict) else q
  if co: polys.append(trans(co))
if not polys: raise RuntimeError('No polygons')
geom={'type':'Polygon','coordinates':polys[0]} if len(polys)==1 else {'type':'MultiPolygon','coordinates':polys}
path=ROOT/'smm.geojson'; d=json.loads(path.read_text(encoding='utf-8')); d['features']=[f for f in d['features'] if f['id']!='smm-dt4']
props={'district':'Дмитровский','section':'Участок 2','name':'ДТ-4 «Г-образный» — маршрут СММ','address':'Клязьминская ул., д. 5, к. 1','source_address':'ДТ\\Клязьминская ул. 5 к.1','scheme':'smm/dt4.svg','detail':'smm/#dt4','status':'Контур подтверждён АСУ ОДС','storage':'Н-4 — место определяется ответственным после осмотра','passes':'Последовательная обработка двух плеч; число проходов — по натурному замеру','note':'Рабочая схема для Г-образного двора. Контур выгружен из АСУ ОДС; направление выброса и зона складирования утверждаются ответственным за участок.','source_yard_id':str(OID),'asu_ods_object_id':str(OID),'asu_ods_type_id':TYPE,'coordinate_system_source':'sr-org:8343 (МСК-77)','coordinate_system_output':'WGS84 / CRS84','geometry_status':'Контур выгружен из АСУ ОДС','retrieved_at':'2026-08-27'}
d['features'].append({'type':'Feature','id':'smm-dt4','properties':props,'geometry':geom});d['metadata']['updated_at']='2026-08-27';d['metadata']['feature_count']=len(d['features']);path.write_text(json.dumps(d,ensure_ascii=False,indent=2),encoding='utf-8')
# SVG schematic: a reviewed conceptual operational route, not measurement-grade.
ring=geom['coordinates'][0] if geom['type']=='Polygon' else geom['coordinates'][0][0]; xs=[p[0] for p in ring];ys=[p[1] for p in ring];minx,maxx,miny,maxy=min(xs),max(xs),min(ys),max(ys); w,h=1000,680; pad=70; sx=(w-2*pad)/(maxx-minx);sy=(h-190)/(maxy-miny);scale=min(sx,sy); ox=(w-(maxx-minx)*scale)/2;oy=100+(h-190-(maxy-miny)*scale)/2
def P(p):return (ox+(p[0]-minx)*scale,h-90-(p[1]-miny)*scale)
points=' '.join(f'{x:.1f},{y:.1f}' for x,y in map(P,ring))
# visually explain a route by using centroid-aligned sequential strokes spanning the two long courtyard arms.
from shapely.geometry import shape
from shapely.affinity import rotate
sh=shape(geom); c=sh.centroid; coords=list(sh.exterior.coords); # Use bounds-based elongated strokes, clipped conceptually inside plan.
b=sh.bounds; y1=b[1]+(b[3]-b[1])*.34;y2=b[1]+(b[3]-b[1])*.48;x1=b[0]+(b[2]-b[0])*.28;x2=b[0]+(b[2]-b[0])*.55
segments=[(P((b[0]+(b[2]-b[0])*.13,y1)),P((b[0]+(b[2]-b[0])*.63,y1))),(P((b[0]+(b[2]-b[0])*.16,y2)),P((b[0]+(b[2]-b[0])*.63,y2))),(P((x2,b[1]+(b[3]-b[1])*.17)),P((x2,b[1]+(b[3]-b[1])*.78))),(P((x1,b[1]+(b[3]-b[1])*.17)),P((x1,b[1]+(b[3]-b[1])*.72)))]
segsvg=''.join(f'<line x1="{a[0]:.1f}" y1="{a[1]:.1f}" x2="{z[0]:.1f}" y2="{z[1]:.1f}" marker-end="url(#arrow)"/>' for a,z in segments)
svg=f'''<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="680" viewBox="0 0 1000 680"><defs><marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#0d47a1"/></marker></defs><rect width="1000" height="680" fill="#f7f8fa"/><text x="40" y="42" font-family="Arial" font-size="25" font-weight="700" fill="#101418">ДТ-4 «Г-образный» — последовательная обработка плеч</text><text x="40" y="70" font-family="Arial" font-size="15" fill="#5c6672">Клязьминская ул., д. 5, к. 1 · Дмитровский район · Участок 2</text><polygon points="{points}" fill="#e9f3e9" stroke="#c00000" stroke-width="4"/><g stroke="#0d47a1" stroke-width="7" stroke-linecap="round">{segsvg}</g><g font-family="Arial" font-size="15" fill="#17212b"><rect x="40" y="600" width="18" height="18" fill="#e9f3e9" stroke="#c00000" stroke-width="2"/><text x="68" y="615">Контур из АСУ ОДС</text><line x1="280" y1="608" x2="340" y2="608" stroke="#0d47a1" stroke-width="5" marker-end="url(#arrow)"/><text x="354" y="615">Очередность проходов: первое плечо → поворот → второе плечо</text><text x="40" y="650" font-size="13" fill="#8a5200">Направление выброса и место Н-4 утверждаются после натурного осмотра.</text></g></svg>'''
(ROOT/'smm'/'dt4.svg').write_text(svg,encoding='utf-8')
print('added official dt4',len(polys),'polygons')
