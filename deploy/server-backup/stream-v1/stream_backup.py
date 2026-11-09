#!/usr/bin/python3
"""Encrypted streaming backups; result.json is the remote commit marker."""
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import threading
import time

ROOT = pathlib.Path('/opt/sao-recovery/server-backups')
RECIPIENTS = '/opt/sao-recovery/backup-recipient.txt'
REMOTE = 'gdrive:SAO-backups/stream-v1'
DBS = [
 ('jira','jirajura-db-1','postgres','sao_inspection'),
 ('luki','luki-sao-luki-db-1','postgres','luki_sao'),
 ('odh','odh-sao-postgres-1','odh_sao','odh_sao'),
 ('photo','sao-photo-service-database-1','sao_photo_service','sao_photo_recovery_20261008'),
]
MEDIA = ['var/lib/docker/volumes/sao-photo-recovery-media-20261008/_data',
         'opt/luki-sao/data/uploads','opt/jirajura/backend/uploads']
CONFIGS = ['opt/jirajura/.env','opt/jirajura/deploy/nginx/active.conf.template',
 'opt/luki-sao/.env','opt/luki-sao/docker-compose.prod.yml',
 'opt/sao-photo-service/photo-service/.env','opt/sao-photo-service/photo-service/compose.yaml',
 'opt/sao-photo-service/photo-service/compose.recovery.yaml',
 'opt/odh-sao/.env','opt/odh-sao/docker-compose.recovery.yml']


def check_remote(expected, entries):
    matches = [x for x in entries if x.get('Name') == expected['file']]
    if len(matches) != 1:
        raise RuntimeError('Uploaded object not uniquely found')
    item = matches[0]
    hashes = {k.lower():v.lower() for k,v in item.get('Hashes',{}).items()}
    if item.get('Size') != expected['bytes'] or hashes.get('md5') != expected['md5'].lower():
        raise RuntimeError('Uploaded object size or MD5 mismatch')


def stream_pipeline(producer, encryptor, uploader, input_data=None, validator=None):
    """Bounded RAM; no payload, encrypted archive or HTTP cache on disk."""
    processes=[]
    errors=[]
    try:
        source=subprocess.Popen(producer, stdin=subprocess.PIPE if input_data is not None else subprocess.DEVNULL, stdout=subprocess.PIPE)
        processes.append(source)
        enc=subprocess.Popen(encryptor,stdin=subprocess.PIPE,stdout=subprocess.PIPE)
        processes.append(enc)
        upload=subprocess.Popen(uploader,stdin=subprocess.PIPE)
        processes.append(upload)
        valid=subprocess.Popen(validator,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL) if validator else None
        if valid: processes.append(valid)
        def input_writer():
            try:
                source.stdin.write(input_data)
                source.stdin.close()
            except BaseException as e: errors.append(type(e).__name__)
        def plain_pump():
            try:
                validate=True
                while True:
                    chunk=source.stdout.read(1024*1024)
                    if not chunk:break
                    enc.stdin.write(chunk)
                    if valid and validate:
                        try:valid.stdin.write(chunk)
                        except BrokenPipeError:validate=False
            except BaseException as e:errors.append(type(e).__name__)
            finally:
                for f in [source.stdout,enc.stdin,valid.stdin if valid else None]:
                    if f:
                        try:f.close()
                        except BrokenPipeError:pass
        feeder=threading.Thread(target=plain_pump,daemon=True)
        feeder.start()
        writer=None
        if input_data is not None:
            writer=threading.Thread(target=input_writer,daemon=True);writer.start()
        sha,md5=hashlib.sha256(),hashlib.md5()
        size=0;last=time.monotonic()
        while True:
            chunk=enc.stdout.read(1024*1024)
            if not chunk:break
            upload.stdin.write(chunk)
            sha.update(chunk);md5.update(chunk);size+=len(chunk)
            if time.monotonic()-last>30:
                print(json.dumps({'streamed_bytes':size}),flush=True);last=time.monotonic()
        upload.stdin.close();enc.stdout.close()
        feeder.join(timeout=120)
        if writer:writer.join(timeout=120)
        codes=[p.wait(timeout=120) for p in processes]
        if feeder.is_alive() or errors or any(codes):
            raise RuntimeError('Streaming pipeline failed: '+str(codes)+' '+str(errors))
        if size==0:raise RuntimeError('Empty encrypted stream')
        return {'bytes':size,'sha256':sha.hexdigest(),'md5':md5.hexdigest()}
    finally:
        for p in processes:
            if p.poll() is None:
                p.terminate()
        for p in processes:
            try:p.wait(timeout=5)
            except subprocess.TimeoutExpired:p.kill();p.wait()
            for stream in [p.stdin,p.stdout]:
                if stream:
                    try:stream.close()
                    except (OSError,BrokenPipeError):pass


def remote_entries(path):
    return json.loads(subprocess.check_output(['rclone','lsjson',path,'--files-only','--hash'],text=True))


def small_upload(data, path):
    subprocess.run(['rclone','rcat',path,'--retries','1','--low-level-retries','3',
                    '--drive-chunk-size','16M','--buffer-size','8M'],input=data,check=True)
    item={'file':path.rsplit('/',1)[-1],'bytes':len(data),'md5':hashlib.md5(data).hexdigest()}
    check_remote(item,remote_entries(path.rsplit('/',1)[0]))


def backup(kind, only_db=None):
    if shutil.disk_usage(ROOT).free<1024**3:
        raise RuntimeError('At least 1 GiB free is required for running services')
    subprocess.run(['rclone','lsf',REMOTE.rsplit('/',1)[0],'--dirs-only'],stdout=subprocess.DEVNULL,check=True)
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    scope='smoke' if only_db else kind
    remote=REMOTE+'/'+scope+'/'+stamp
    dest=ROOT/('stream-'+stamp+'-'+scope)
    dest.mkdir(mode=0o700)
    report={'format':'sao-stream-v1','created_at':stamp,'kind':scope,
            'remote':remote,'cloud_status':'incomplete','components':[],
            'consistency':'Each database individually consistent; media copied online, no cross-service atomic snapshot'}
    def component(name, command, validator=None):
        print(json.dumps({'component':name,'phase':'uploading'}),flush=True)
        meta=stream_pipeline(command,['age','-R',RECIPIENTS],
            ['rclone','rcat',remote+'/'+name,'--retries','1','--low-level-retries','3',
             '--drive-chunk-size','16M','--buffer-size','8M'],validator=validator)
        meta['file']=name
        check_remote(meta,remote_entries(remote))
        if validator:meta['validation']='pg_restore --list accepted the source stream'
        report['components'].append(meta)
        (dest/'progress.json').write_text(json.dumps(report,indent=2))
        print(json.dumps({'component':name,'phase':'verified','bytes':meta['bytes']}),flush=True)
    try:
        if kind=='database':
            selected=[d for d in DBS if not only_db or d[0]==only_db]
            for name,container,user,db in selected:
                component(name+'.dump.age',['docker','exec',container,'pg_dump','-U',user,'-d',db,'-Fc'],
                          ['docker','exec','-i',container,'pg_restore','--list'])
            report['databases']={name:db for name,_,_,db in selected}
        else:
            component('media.tar.age',['tar','-cf','-','-C','/']+MEDIA)
            report['media_paths']=MEDIA
        configs=[p for p in CONFIGS if pathlib.Path('/'+p).is_file()]
        if not configs:raise RuntimeError('No service configuration found')
        component('configuration-private.tar.age',['tar','-cf','-','-C','/']+configs)
        report['cloud_status']='uploaded_size_md5_verified'
        data=json.dumps(report,indent=2).encode()
        # A remotely verified result.json is written LAST; incomplete folders are not backups.
        small_upload(data,remote+'/result.json')
        (dest/'result.json').write_bytes(data)
        (dest/'progress.json').unlink(missing_ok=True)
        (ROOT/('stream-latest-'+scope+'.json')).write_bytes(data)
        print(json.dumps({'phase':'committed','kind':scope,'remote':remote}),flush=True)
        return report
    except BaseException:
        report['cloud_status']='incomplete'
        (dest/'failed.json').write_text(json.dumps(report,indent=2))
        raise


def verify():
    for kind in ['database','media']:
        report=json.loads((ROOT/('stream-latest-'+kind+'.json')).read_text())
        if report.get('cloud_status')!='uploaded_size_md5_verified':
            raise RuntimeError('Latest backup is not committed')
        entries=remote_entries(report['remote'])
        for item in report['components']:check_remote(item,entries)
        committed=subprocess.check_output(['rclone','cat',report['remote']+'/result.json'])
        if json.loads(committed)!=report:raise RuntimeError('Remote commit marker mismatch')
        print(json.dumps({'kind':kind,'created_at':report['created_at'],'verified':True}),flush=True)


def main():
    os.umask(0o077)
    ROOT.mkdir(exist_ok=True)
    command=sys.argv[1] if len(sys.argv)>1 else ''
    if command not in ['database','media','smoke','verify']:
        raise SystemExit('Use: stream_backup.py database|media|smoke|verify')
    with (ROOT/'backup.lock').open('a') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        if command=='verify':verify()
        elif command=='smoke':backup('database',only_db='luki')
        else:backup(command)


if __name__=='__main__':main()
