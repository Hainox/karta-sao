from __future__ import annotations
import json, math, os, time
from pathlib import Path
import requests
BASE='https://reestr-ogh.mos.ru'; API=BASE+'/api'; TYPE=38
A=6377397.155; E2=0.006674372230614; LAT0=55.66666666667; LON0=37.5
TARGETS={
 'smm-dt1': {'id':128225627500038,'name':'ДТ-1 «Каре» — маршрут СММ','address':'ул. Новопесчаная, д. 21'},
 'smm-dt2': {'id':132070173500038,'name':'ДТ-2 «Линейный» — маршрут СММ','address':'ул. Дубнинская, д. 30'},
 'smm-dt3': {'id':128225324100038,'name':'ДТ-3 «Гребёнка» — маршрут СММ','address':'Бескудниковский б-р, д. 20'},
}
def arc(phi):
 return A*((1-E2/4-3*E2**2/64-5*E2**3/256)*phi-(3*E2/8+3*E2**2/32+45*E2**3/1024)*math.sin(2*phi)+(15*E2**2/256+45*E2**3/1024)*math.sin(4*phi)-(35*E2**3/3072)*math.sin(6*phi))
def msk77(coord):
 x,y=map(float,coord); lat0=math.radians(LAT0); lon0=math.radians(LON0); m=arc(lat0)+y
 mu=m/(A*(1-E2/4-3*E2**2/64-5*E2**3/256)); e1=(1-math.sqrt(1-E2))/(1+math.sqrt(1-E2))
 fp=mu+(3*e1/2-27*e1**3/32)*math.sin(2*mu)+(21*e1**2/16-55*e1**4/32)*math.sin(4*mu)+(151*e1**3/96)*math.sin(6*mu)+(1097*e1**4/512)*math.sin(8*mu)
 sp,cp,tp=math.sin(fp),math.cos(fp),math.tan(fp); c=E2/(1-E2)*cp**2; n=A/math.sqrt(1-E2*sp**2); r=A*(1-E2)/(1-E2*sp**2)**1.5; d=x/n
 lat=fp-(n*tp/r)*(d*d/2-(5+3*tp*tp+10*c-4*c*c-9*E2/(1-E2))*d**4/24+(61+90*tp*tp+298*c+45*tp**4-252*E2/(1-E2)-3*c*c)*d**6/720)
 lon=lon0+(d-(1+2*tp*tp+c)*d**3/6+(5-2*c+28*tp*tp-3*c*c+8*E2/(1-E2)+24*tp**4)*d**5/120)/cp
 # Bessel -> WGS84 Helmert
 bf=1/299.1528128; be2=2*bf-bf*bf; sl,cl=math.sin(lat),math.cos(lat); radius=A/math.sqrt(1-be2*sl*sl)
 bx=radius*cl*math.cos(lon); by=radius*cl*math.sin(lon); bz=radius*(1-be2)*sl
 rx,ry,rz=[math.radians(v/3600) for v in (-.8777,1.3231,2.6248)]; scale=1+8.96e-6
 wx=367.93+scale*bx-rz*by+ry*bz; wy=88.45+rz*bx+scale*by-rx*bz; wz=553.73-ry*bx+rx*by+scale*bz
 wa=6378137.; we2=6.6943799901413165e-3; lonw=math.atan2(wy,wx); p=math.hypot(wx,wy); latw=math.atan2(wz,p*(1-we2))
 for _ in range(8):
  ss=math.sin(latw); nn=wa/math.sqrt(1-we2*ss*ss); latw=math.atan2(wz+we2*nn*ss,p)
 return [math.degrees(lonw),math.degrees(latw)]
def transform(v):
 if isinstance(v,list) and len(v)==2 and all(isinstance(a,(int,float)) for a in v): return msk77(v)
 return [transform(a) for a in v]
h={'User-Agent':'Mozilla/5.0 SAO-Contour-Load/1.0','Accept':'application/json','Origin':BASE,'Referer':BASE+'/r/ogh/odh'}
s=requests.Session(); s.get(BASE+'/auth/login',headers=h,timeout=30)
r=s.post(API+'/login',headers={**h,'Content-Type':'application/x-www-form-urlencoded'},data={'username':os.environ['ODS_USERNAME'],'password':os.environ['ODS_PASSWORD'],'j_username':os.environ['ODS_USERNAME'],'j_password':os.environ['ODS_PASSWORD']},timeout=30); r.raise_for_status()
features=[]
for key,info in TARGETS.items():
 r=s.get(API+'/ogh/geometry/full',params={'id':info['id'],'root_id':info['id'],'type_id':TYPE},headers=h,timeout=120); r.raise_for_status(); objects=r.json() or []
 polys=[]
 for obj in objects:
  for poly in obj.get('polygons') or []:
   coords=poly.get('coordinates') if isinstance(poly,dict) else poly
   if coords: polys.append(transform(coords))
 if not polys: raise RuntimeError(f'{key}: no polygons')
 geom={'type':'Polygon','coordinates':polys[0]} if len(polys)==1 else {'type':'MultiPolygon','coordinates':polys}
 features.append({'type':'Feature','id':key,'properties':{**info,'asu_ods_object_id':str(info['id']),'asu_ods_type_id':TYPE,'coordinate_system_source':'sr-org:8343 (MSK-77)','coordinate_system_output':'WGS84 / CRS84','geometry_status':'Контур выгружен из АСУ ОДС','retrieved_at':'2026-08-27'},'geometry':geom})
 print(key,'polygons',len(polys))
out={'type':'FeatureCollection','name':'smm_asu_ods_official','metadata':{'source':'АСУ ОДС / reestr-ogh.mos.ru','type_id':TYPE,'coordinate_conversion':'sr-org:8343 (MSK-77) -> WGS84 / CRS84','retrieved_at':'2026-08-27'},'features':features}
Path(r'C:\Users\root\Downloads\КАРТА\work\smm_asu_ods_official_preview.geojson').write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
