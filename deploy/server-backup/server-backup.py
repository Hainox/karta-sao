#!/usr/bin/python3
# Nightly encrypted backup of the SAO databases or media on obhod-sao.ru.
# Installed as /opt/sao-recovery/server-backup.py next to sao_backup_retention.py;
# run by sao-backup-database.timer / sao-backup-media.timer, uploaded by sao-offsite.sh.
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

from sao_backup_retention import rotate_backups

ROOT = pathlib.Path('/opt/sao-recovery/server-backups')
RECIPIENTS = '/opt/sao-recovery/backup-recipient.txt'
# Two local copies are enough: Google Drive keeps 30 database copies (sao-offsite.sh).
KEEP = 2
# The photo database grows by gigabytes a day, so assume the next copy is bigger than the last.
GROWTH = 1.3
FREE_SPACE_MARGIN = 5 * 1024**3
# Names a run of this script writes before result.json exists; anything else is left alone.
RUN_FILES = {'payload', 'payload.tar'}


def snapshot_pattern(kind):
    return re.compile(r'\d{8}T\d{6}Z-' + kind)


def remove_leftovers(root, kind):
    """Delete directories left by runs that died before writing result.json (e.g. disk full).

    They hold unencrypted dumps and are invisible to rotate_backups, which only
    counts complete snapshots, so without this they pile up forever.
    """
    removed = []
    for path in sorted(pathlib.Path(root).iterdir()):
        if not snapshot_pattern(kind).fullmatch(path.name) or path.is_symlink() or not path.is_dir():
            continue
        if (path / 'result.json').exists():
            continue
        allowed = RUN_FILES | {f'sao-{path.name}.tar.age'}
        if any(child.name not in allowed for child in path.iterdir()):
            continue
        shutil.rmtree(path)
        removed.append(path.name)
    return removed


def last_snapshot_bytes(root, kind):
    for path in sorted(pathlib.Path(root).iterdir(), reverse=True):
        if not snapshot_pattern(kind).fullmatch(path.name):
            continue
        try:
            return json.loads((path / 'result.json').read_text())['encrypted']['bytes']
        except (OSError, KeyError, ValueError):
            continue
    return 0


def required_free_bytes(last_bytes):
    # During a run the plaintext payload and the encrypted archive exist side by side.
    return int(2 * last_bytes * GROWTH) + FREE_SPACE_MARGIN


def free_bytes(root):
    return shutil.disk_usage(root).free


def ensure_free_space(root, kind):
    need = required_free_bytes(last_snapshot_bytes(root, kind))
    have = free_bytes(root)
    if have < need:
        raise SystemExit(
            f'Недостаточно места для копии {kind}: свободно {have / 1024**3:.1f} ГБ, '
            f'нужно {need / 1024**3:.1f} ГБ. Копия не начата, чтобы не заполнить диск и не уронить базу.'
        )


def run(args, output=None):
    if output:
        with open(output, 'wb') as f:
            subprocess.run(args, stdout=f, check=True)
    else:
        subprocess.run(args, check=True)


def digest(path, algorithm='sha256'):
    h = hashlib.new(algorithm)
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1048576), b''):
            h.update(block)
    return h.hexdigest()


def encrypt_directory(work, encrypted, encrypt_command):
    # tar streams straight into age: no plaintext payload.tar, half the peak disk use.
    tar = subprocess.Popen(['tar', '-cf', '-', '-C', str(work), '.'], stdout=subprocess.PIPE)
    encrypt = subprocess.Popen(encrypt_command, stdin=tar.stdout)
    tar.stdout.close()
    encrypt_status, tar_status = encrypt.wait(), tar.wait()
    if encrypt_status or tar_status:
        raise RuntimeError(f'Шифрование не удалось: tar={tar_status}, age={encrypt_status}')


def create_snapshot(root, kind, stamp, build):
    dest = pathlib.Path(root) / f'{stamp}-{kind}'
    dest.mkdir()
    try:
        return build(dest)
    except BaseException:
        shutil.rmtree(dest, ignore_errors=True)
        raise


def build_payload(work, kind):
    report = {
        'kind': kind,
        'database_snapshot': 'each DB individually consistent; no cross-service atomic snapshot',
        'cloud_status': 'not_configured',
    }
    if kind == 'database':
        dbs = [
            ('jira', 'jirajura-db-1', 'postgres', 'sao_inspection'),
            ('luki', 'luki-sao-luki-db-1', 'postgres', 'luki_sao'),
            ('odh', 'odh-sao-postgres-1', 'odh_sao', 'odh_sao'),
            ('photo', 'sao-photo-service-database-1', 'sao_photo_service', 'sao_photo_recovery_20261008'),
        ]
        for name, container, user, db in dbs:
            path = work / f'{name}.dump'
            run(['docker', 'exec', container, 'pg_dump', '-U', user, '-d', db, '-Fc'], path)
            with open(path, 'rb') as f:
                toc = subprocess.run(['docker', 'exec', '-i', container, 'pg_restore', '-l'], stdin=f, stdout=subprocess.PIPE, check=True)
            (work / f'{name}.toc').write_bytes(toc.stdout)
        report['databases'] = {name: db for name, _, _, db in dbs}
    else:
        run(['tar', '-cf', str(work / 'media.tar'), '-C', '/',
             'var/lib/docker/volumes/sao-photo-recovery-media-20261008/_data',
             'opt/luki-sao/data/uploads', 'opt/jirajura/backend/uploads'])
        run(['tar', '-tf', str(work / 'media.tar')], work / 'media-files.txt')
        report['media_snapshot'] = 'online file copy; append-only media may include files newer than database snapshot'
    configs = [
        'opt/jirajura/.env', 'opt/jirajura/deploy/nginx/active.conf.template',
        'opt/luki-sao/.env', 'opt/luki-sao/docker-compose.prod.yml',
        'opt/sao-photo-service/photo-service/.env', 'opt/sao-photo-service/photo-service/compose.yaml',
        'opt/sao-photo-service/photo-service/compose.recovery.yaml',
        'opt/odh-sao/.env', 'opt/odh-sao/docker-compose.recovery.yml',
    ]
    configs = [p for p in configs if pathlib.Path('/' + p).is_file()]
    run(['tar', '-cf', str(work / 'configuration-private.tar'), '-C', '/'] + configs)
    report['files'] = {p.name: {'bytes': p.stat().st_size, 'sha256': digest(p)} for p in work.iterdir()}
    return report


def backup(dest, kind, stamp):
    work = dest / 'payload'
    work.mkdir()
    report = {'created_at': stamp, **build_payload(work, kind)}
    (work / 'manifest.json').write_text(json.dumps(report, indent=2))
    encrypted = dest / f'sao-{stamp}-{kind}.tar.age'
    encrypt_directory(work, encrypted, ['age', '-R', RECIPIENTS, '-o', str(encrypted)])
    shutil.rmtree(work)
    report['encrypted'] = {'file': encrypted.name, 'bytes': encrypted.stat().st_size,
                           'sha256': digest(encrypted), 'md5': digest(encrypted, 'md5')}
    cfg = pathlib.Path('/root/.config/rclone/sao-backup.conf')
    if cfg.is_file():
        remote = f'sao-offsite:{kind}/{encrypted.name}'
        run(['rclone', '--config', str(cfg), 'copyto', str(encrypted), remote, '--retries', '3'])
        md5 = subprocess.check_output(['rclone', '--config', str(cfg), 'md5sum', remote], text=True).split()[0]
        if md5 != report['encrypted']['md5']:
            raise RuntimeError('Offsite encrypted content checksum mismatch')
        report['cloud_status'] = 'uploaded_md5_verified'
        report['remote'] = remote
    # result.json last: its presence is what marks the snapshot complete for rotate_backups.
    (dest / 'result.json').write_text(json.dumps(report, indent=2))
    return report


def main(kind):
    assert kind in ('database', 'media')
    os.umask(0o077)
    ROOT.mkdir(exist_ok=True)
    lock = open(ROOT / 'backup.lock', 'a')
    fcntl.flock(lock, fcntl.LOCK_EX)
    leftovers = remove_leftovers(ROOT, kind)
    # Make room before writing: keep KEEP-1 old copies during the run, KEEP after it.
    before = rotate_backups(ROOT, kind, KEEP - 1)
    ensure_free_space(ROOT, kind)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    report = create_snapshot(ROOT, kind, stamp, lambda dest: backup(dest, kind, stamp))
    retention = rotate_backups(ROOT, kind, KEEP)
    retention['removed_old_generated_snapshots'] = before['removed_old_generated_snapshots'] + retention['removed_old_generated_snapshots']
    retention['removed_failed_runs'] = leftovers
    (ROOT / f'retention-last-{kind}.json').write_text(json.dumps(retention, indent=2))
    print(json.dumps({'directory': str(ROOT / f'{stamp}-{kind}'), 'kind': kind,
                      'cloud_status': report['cloud_status'], 'encrypted': report['encrypted']}))


if __name__ == '__main__':
    main(sys.argv[1])
