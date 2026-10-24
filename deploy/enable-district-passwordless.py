#!/usr/bin/env python3
"""Enable public district entry without replacing unrelated server changes."""
from pathlib import Path
import datetime
import shutil
import subprocess

POLICY = "// District entry is intentionally public. Role and scope always come from the DB.\nexport async function authenticateMapUser(user, password) {\n  if (!user || user.active !== true) return false;\n  const district = normalizeLogin(user.district).replace(/ё/g, 'е');\n  const districtAllowed = [...DISTRICTS, 'АвД САО'].some((name) => normalizeLogin(name).replace(/ё/g, 'е') === district);\n  if (user.role === 'district_editor' && districtAllowed) return true;\n  return verifyPassword(password, user.password_hash);\n}\n"

def patch_sources(auth, server):
    if 'export async function authenticateMapUser(' in auth:
        raise RuntimeError('Passwordless policy already exists; inspect the installed version before updating.')
    if "from './tpu-points/validation.js'" not in auth:
        auth = "import { DISTRICTS } from './tpu-points/validation.js';\n" + auth
    auth = auth.rstrip() + '\n\n' + POLICY
    replacements = [
        ('sessionCookie, verifyPassword,', 'sessionCookie, authenticateMapUser,'),
        ('!user || !(await verifyPassword(body.password, user.password_hash))', '!(await authenticateMapUser(user, body.password))'),
        ('  loginThrottle.clear(key);', "  // Public entry must not reset the prefecture password failure counter.\n  if (user.role !== 'district_editor') loginThrottle.clear(key);"),
    ]
    for old, new in replacements:
        if server.count(old) != 1:
            raise RuntimeError('Installed login handler differs; no files changed: ' + old)
        server = server.replace(old, new, 1)
    return auth, server

def main():
    root = Path('/opt/sao-photo-service/photo-service')
    if root.resolve() != root or not (root / 'compose.recovery.yaml').is_file():
        raise RuntimeError('Expected recovered production configuration is missing.')
    targets = [root / 'src/auth.js', root / 'server.js']
    if any(p.is_symlink() or not p.is_file() for p in targets):
        raise RuntimeError('Unexpected production source paths.')
    container = 'sao-photo-service-photo-service-1'
    db = subprocess.check_output(['docker', 'exec', container, 'printenv', 'PHOTO_SERVICE_DB_NAME'], text=True).strip()
    if db != 'sao_photo_recovery_20261008':
        raise RuntimeError('Unexpected live database; no files changed.')
    patched = patch_sources(*(p.read_text(encoding='utf-8') for p in targets))
    for source in patched:
        subprocess.run(['docker', 'exec', '-i', container, 'node', '--check', '--input-type=module'], input=source, text=True, check=True)
    backup = root / ('passwordless-rollback-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    backup.mkdir(mode=0o700)
    for path in targets:
        shutil.copy2(path, backup / path.name)
    for path, source in zip(targets, patched):
        path.write_text(source, encoding='utf-8', newline='\n')
    print('Sources updated. Rollback files: ' + str(backup))
    print('Rebuild and restart photo-service with compose.yaml AND compose.recovery.yaml.')

if __name__ == '__main__':
    main()
