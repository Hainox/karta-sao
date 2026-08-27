import os, requests
BASE='https://reestr-ogh.mos.ru'; API=BASE+'/api'; TYPE=38
h={'User-Agent':'Mozilla/5.0 SAO-SMM/1.0','Accept':'application/json','Origin':BASE,'Referer':BASE+'/r/ogh/odh'}
s=requests.Session(); s.get(BASE+'/auth/login',headers=h,timeout=30)
r=s.post(API+'/login',headers={**h,'Content-Type':'application/x-www-form-urlencoded'},data={'username':os.environ['ODS_USERNAME'],'password':os.environ['ODS_PASSWORD'],'j_username':os.environ['ODS_USERNAME'],'j_password':os.environ['ODS_PASSWORD']},timeout=30); r.raise_for_status()
common={'main_page':True,'max_rows':50,'parent_type_id':-1,'sort':'root_id.asc','type_id':TYPE,'ogh_types':[TYPE]}
r=s.post(API+'/registry/ogh/count',json={**common,'page':0},headers={**h,'Content-Type':'application/json'},timeout=60); r.raise_for_status(); n=int(r.json()['data']['count']); print('count',n)
needle='Амбулатор'
for page in range((n+49)//50):
    r=s.post(API+'/registry/ogh',json={**common,'page':page},headers={**h,'Content-Type':'application/json'},timeout=120); r.raise_for_status()
    for x in r.json().get('data',[]):
        text=' '.join(str(v) for v in x.values() if v is not None)
        if needle.lower() in text.lower(): print(x)
    print('page',page+1,flush=True)
