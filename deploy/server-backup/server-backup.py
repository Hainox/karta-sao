#!/usr/bin/python3
import pathlib,subprocess,datetime,json,hashlib,os,fcntl,sys,tarfile
from sao_backup_retention import rotate_backups
os.umask(0o077)
root=pathlib.Path('/opt/sao-recovery/server-backups');root.mkdir(exist_ok=True)
lock=open(root/'backup.lock','a');fcntl.flock(lock,fcntl.LOCK_EX)
kind=sys.argv[1];assert kind in ('database','media')
stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
dest=root/(stamp+'-'+kind);dest.mkdir()
work=dest/'payload';work.mkdir()
def run(args,output=None):
 if output:
  with open(output,'wb') as f:subprocess.run(args,stdout=f,check=True)
 else:subprocess.run(args,check=True)
def digest(p,algorithm='sha256'):
 h=hashlib.new(algorithm)
 with open(p,'rb') as f:
  for b in iter(lambda:f.read(1048576),b''):h.update(b)
 return h.hexdigest()
report={'created_at':stamp,'kind':kind,'database_snapshot':'each DB individually consistent; no cross-service atomic snapshot','cloud_status':'not_configured'}
if kind=='database':
 dbs=[('jira','jirajura-db-1','postgres','sao_inspection'),('luki','luki-sao-luki-db-1','postgres','luki_sao'),('odh','odh-sao-postgres-1','odh_sao','odh_sao'),('photo','sao-photo-service-database-1','sao_photo_service','sao_photo_recovery_20261008')]
 for name,container,user,db in dbs:
  path=work/(name+'.dump');run(['docker','exec',container,'pg_dump','-U',user,'-d',db,'-Fc'],path)
  with open(path,'rb') as f:
   r=subprocess.run(['docker','exec','-i',container,'pg_restore','-l'],stdin=f,stdout=subprocess.PIPE,check=True)
  (work/(name+'.toc')).write_bytes(r.stdout)
 report['databases']={x[0]:x[3] for x in dbs}
else:
 run(['tar','-cf',str(work/'media.tar'),'-C','/','var/lib/docker/volumes/sao-photo-recovery-media-20261008/_data','opt/luki-sao/data/uploads','opt/jirajura/backend/uploads'])
 run(['tar','-tf',str(work/'media.tar')],work/'media-files.txt')
 report['media_snapshot']='online file copy; append-only media may include files newer than database snapshot'
configs=['opt/jirajura/.env','opt/jirajura/deploy/nginx/active.conf.template','opt/luki-sao/.env','opt/luki-sao/docker-compose.prod.yml','opt/sao-photo-service/photo-service/.env','opt/sao-photo-service/photo-service/compose.yaml','opt/sao-photo-service/photo-service/compose.recovery.yaml','opt/odh-sao/.env','opt/odh-sao/docker-compose.recovery.yml']
configs=[p for p in configs if pathlib.Path('/'+p).is_file()]
run(['tar','-cf',str(work/'configuration-private.tar'),'-C','/']+configs)
report['files']={p.name:{'bytes':p.stat().st_size,'sha256':digest(p)} for p in work.iterdir()}
(work/'manifest.json').write_text(json.dumps(report,indent=2))
tarpath=dest/'payload.tar'
run(['tar','-cf',str(tarpath),'-C',str(work),'.'])
encrypted=dest/('sao-'+stamp+'-'+kind+'.tar.age')
run(['age','-R','/opt/sao-recovery/backup-recipient.txt','-o',str(encrypted),str(tarpath)])
report['encrypted']={'file':encrypted.name,'bytes':encrypted.stat().st_size,'sha256':digest(encrypted),'md5':digest(encrypted,'md5')}
cfg=pathlib.Path('/root/.config/rclone/sao-backup.conf')
if cfg.is_file():
 remote='sao-offsite:'+kind+'/'+encrypted.name
 run(['rclone','--config',str(cfg),'copyto',str(encrypted),remote,'--retries','3'])
 md5=subprocess.check_output(['rclone','--config',str(cfg),'md5sum',remote],text=True).split()[0]
 if md5!=report['encrypted']['md5']:raise RuntimeError('Offsite encrypted content checksum mismatch')
 report['cloud_status']='uploaded_md5_verified';report['remote']=remote
(dest/'result.json').write_text(json.dumps(report,indent=2))
# Only remove disposable plaintext generated in this exact run.
for p in work.iterdir():p.unlink()
work.rmdir();tarpath.unlink()
retention=rotate_backups(root,kind,3)
(root/('retention-last-'+kind+'.json')).write_text(json.dumps(retention,indent=2))
print(json.dumps({'directory':str(dest),'kind':kind,'cloud_status':report['cloud_status'],'encrypted':report['encrypted']}))
