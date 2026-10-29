# Production runbook: sao-photo-service

## Isolation

- Application directory: `/opt/sao-photo-service`.
- Compose project: `sao-photo-service`.
- PostgreSQL database/user: `sao_photo_service`.
- PostgreSQL and media volumes are named with the `sao-photo-service` prefix.
- API container uses private Compose network plus `sao-photo-service-edge`; database uses only the private default network. The existing ODH/JiraJura database and network are not reused.
- Reverse-proxy is the only component attached to `sao-photo-service-edge`.

## First install

```sh
install -d -m 0750 /opt/sao-photo-service /var/backups/sao-photo-service
docker network inspect sao-photo-service-edge >/dev/null 2>&1 || docker network create sao-photo-service-edge
cd /opt/sao-photo-service/photo-service
docker compose -p sao-photo-service up -d --build database photo-service
docker compose -p sao-photo-service run --rm photo-service node scripts/migrate.js
docker compose -p sao-photo-service run --rm -v /opt/sao-photo-service:/sources:ro photo-service node scripts/import-object-maps.js --apply --source-root=/sources
```

The source root must contain `object-maps/data/manifest.json`, `object-maps/data/*.json` and `districts.geojson`; the import verifies the SHA-256 of every dataset against the manifest and aborts on a mismatch. Each applied import is recorded in `import_runs` with the source version, hashes and the explicit list of objects without a district.

Production `.env` must set the cross-site session and the exact allowed origins, otherwise the atlas on GitHub Pages cannot keep a session:

```sh
PHOTO_SERVICE_COOKIE_SAMESITE=none
PHOTO_SERVICE_COOKIE_PATH=/photo-api
PHOTO_SERVICE_ALLOWED_ORIGINS=https://hainox.github.io,https://obhod-sao.ru
```

Create accounts only through the hidden-input CLI, one account at a time. Never put a password in a command argument or repository file.

## Updating an installed service

> **Production runs on the recovered database — always pass both compose files.**
> Since 2026-10-08 the live service on obhod-sao.ru uses the database `sao_photo_recovery_20261008` and the media volume `sao-photo-recovery-media-20261008`. Both are switched on by `compose.recovery.yaml`, which lives only on the server, next to `compose.yaml`. Every `docker compose` command for the photo service there must include it:
>
> ```sh
> cd /opt/sao-photo-service/photo-service
> DC="docker compose -p sao-photo-service -f compose.yaml -f compose.recovery.yaml"
> $DC build photo-service
> $DC run --rm photo-service node scripts/migrate.js
> $DC up -d photo-service
> ```
>
> Without `-f compose.recovery.yaml` the service starts on the empty database `sao_photo_service`: every login fails with «Неверный логин или пароль», and the maps show no shooting points. This happened on 2026-10-19 (fixed by rerunning the commands above, no data lost). Never use `--remove-orphans` and never delete the `sao-photo-recovery-*` volumes or the `sao-photo-service_*` volumes.
>
> Check after every restart. Both commands must show data, not empty lists:
>
> ```sh
> $DC exec photo-service env | grep PHOTO_SERVICE_DB_NAME        # sao_photo_recovery_20261008
> curl -s "https://obhod-sao.ru/photo-api/object-photo-points/public?dataset=sao_district_photo_points" | head -c 200
> ```
>
> The commands below are written for a plain install; on obhod-sao.ru replace `docker compose -p sao-photo-service` with `$DC`.

Reports count source points (`photos.source_id`), so the database must know the point of every photo before the new code starts. The migration and the one-off binding are separate steps; skipping the migration makes the whole report query fail, skipping the binding leaves the point-based coverage at zero for photos uploaded earlier.

```sh
cd /opt/sao-photo-service/photo-service
git pull
docker compose -p sao-photo-service build photo-service
docker compose -p sao-photo-service run --rm photo-service node scripts/migrate.js
docker compose -p sao-photo-service run --rm photo-service node scripts/backfill-photo-source-id.js
docker compose -p sao-photo-service run --rm photo-service node scripts/backfill-photo-source-id.js --apply
docker compose -p sao-photo-service up -d photo-service
```

The binding command is a dry run by default: it prints how many photos it would bind and how many it would skip (no GPS, no registered points). Photos without GPS keep no point and stay on manual review.

### Photo slots on the TPU and parking map (migration 014)

The TPU and parking map lets districts and АвД upload photos into slots (as many as the object's required photo count, one by default) and lets the prefecture accept or reject each photo with a comment. Slots live in the new `object_slot_photos` table, so this release needs the migration before the new code starts. The migration is idempotent and only creates the table and its indexes:

```sh
docker compose -p sao-photo-service build photo-service
docker compose -p sao-photo-service run --rm photo-service node scripts/migrate.js
docker compose -p sao-photo-service up -d photo-service
curl -s https://obhod-sao.ru/photo-api/object-photo-points/slots/public | head -c 200
```

The last command must return `{"objects":[...]}` (an empty list before the first upload). When shipping files with `git archive`, include `photo-service/migrations`, otherwise `scripts/migrate.js` does not see `014_object_slot_photos.sql`.

### Sidewalk shooting points (migration 020, `scripts/import-sidewalk-photo-points.js`)

The district maps let the prefecture move, rotate and delete the draft sidewalk shooting points («Точки съёмки · тротуары (тест)»). The points live in the new `sidewalk_photo_points` table; the migration only creates it and does not touch other data.

`/opt/sao-photo-service` has a `.git` folder, but the files are copied over (see «Shipping the files» below), so `git pull` refuses to run. Fetch the commit and unpack it with `git archive` instead; this never touches `.env` or `compose.recovery.yaml`. Keep a copy of the replaced files first: it is the only rollback.

```sh
cd /opt/sao-photo-service
tar -czf /var/backups/sao-photo-service/photo-service-files-$(date +%F-%H%M).tgz --exclude=photo-service/node_modules photo-service
git fetch origin main
git archive origin/main photo-service/src photo-service/server.js photo-service/scripts photo-service/migrations photo-service/README.md photo-service/package.json photo-service/package-lock.json | tar -x -C /opt/sao-photo-service
grep -rl $'\r' photo-service/src photo-service/migrations | head
rm -rf /tmp/sidewalk-layers && mkdir -p /tmp/sidewalk-layers
git archive origin/main $(git ls-tree -r --name-only origin/main districts/layers | grep sidewalk_shoot.geojson) | tar -x -C /tmp/sidewalk-layers
```

Then rebuild, migrate, load the points and restart. The import is a dry run by default and skips points whose number is already in the table, so rerunning it never overwrites the prefecture's edits:

```sh
cd /opt/sao-photo-service/photo-service
DC="docker compose -p sao-photo-service -f compose.yaml -f compose.recovery.yaml"
$DC build photo-service
$DC run --rm photo-service node scripts/migrate.js
$DC run --rm -v /tmp/sidewalk-layers:/sources:ro photo-service node scripts/import-sidewalk-photo-points.js --source=/sources/districts/layers
$DC run --rm -v /tmp/sidewalk-layers:/sources:ro photo-service node scripts/import-sidewalk-photo-points.js --source=/sources/districts/layers --apply
$DC up -d photo-service
```

`migrate.js` must end with `020_sidewalk_photo_points.sql applied`, and the dry run must report 5 670 points and 0 with errors. Until this is done, the maps show the same points from the layer file, read-only.

Migration 017 used to fail on rerun with «more than one row returned by a subquery used as an expression» once a district point had three or more photos (returns for rework). Since 2026-10-28 it passes on such data and changes nothing there; that failure blocked every update of the service.

### Re-placing the sidewalk points (`--replace`)

When the atlas layers are rebuilt with a new placement, refresh `/tmp/sidewalk-layers` from `origin/main` (the `git archive … districts/layers` step above) and load them with `--replace`. Draft points that nobody edited and that have no photo move to the new place, extra untouched drafts are retired, and points the prefecture moved, rotated or photographed stay as they are; the dry run lists them:

```sh
$DC run --rm -v /tmp/sidewalk-layers:/sources:ro photo-service node scripts/import-sidewalk-photo-points.js --source=/sources/districts/layers --replace
$DC run --rm -v /tmp/sidewalk-layers:/sources:ro photo-service node scripts/import-sidewalk-photo-points.js --source=/sources/districts/layers --replace --apply
```

No restart is needed.

### Sidewalk point photos (migration 021)

Photos of the sidewalk shooting points live in the new `sidewalk_photo_slot_photos` table (one active photo per point, like playgrounds). Ship the files the same way as for migration 020 (`git archive origin/main photo-service/... | tar -x -C /opt/sao-photo-service`, after a copy of the replaced files), then:

```sh
cd /opt/sao-photo-service/photo-service
DC="docker compose -p sao-photo-service -f compose.yaml -f compose.recovery.yaml"
$DC build photo-service
$DC run --rm photo-service node scripts/migrate.js
$DC up -d photo-service
```

`migrate.js` must end with `021_sidewalk_photo_slots.sql applied`. The sidewalk points are already loaded; do not rerun the import.

### Issuing district and АвД accounts (`scripts/issue-district-accounts.js`)

Gives new passwords to the district accounts of the 16 districts and АвД САО only (role `district_editor`); the prefecture and МКД accounts are not touched. Creates the АвД САО account (login `авд сао`) when it does not exist. Without `--apply` it only lists who would get a new password. Passwords are written only to the xlsx file, never to the console; the file has a ready message per district and a sheet with instructions for the TPU and parking map. Old district passwords stop working, including for stops, crossings and entrances (one account per district).

```sh
cd /opt/sao-photo-service/photo-service
DC="docker compose -p sao-photo-service -f compose.yaml -f compose.recovery.yaml"
$DC run --rm photo-service node scripts/issue-district-accounts.js
install -d -m 0777 /tmp/uchetki
$DC run --rm -v /tmp/uchetki:/out photo-service node scripts/issue-district-accounts.js --apply --out /out/uchetki.xlsx
```

Download `/tmp/uchetki/uchetki.xlsx`, then delete it on the server: `rm -rf /tmp/uchetki`.

### Shipping the files on a machine where the checkout is not the source of truth

`/opt` is not a git checkout: files are copied over. Build the release archive with `git archive`, not with an archive of the working copy — on Windows `core.autocrlf=true` puts CRLF into the working copy, and a working-copy archive then writes CRLF into production, including into `Dockerfile`. `git archive` takes the index (always LF), and the rules in `.gitattributes` keep it that way:

```sh
git archive --format=tar.gz -o /tmp/ps.tgz HEAD photo-service/src photo-service/server.js photo-service/scripts photo-service/migrations photo-service/README.md photo-service/package.json photo-service/package-lock.json
git archive --format=tar.gz -o /tmp/odh.tgz HEAD api notify
```

The manifests are part of the release: the image builds with `npm ci`, so a new
dependency that is absent from `package-lock.json` fails the build. Unpack with
`--strip-components=1` into the target directory:

```sh
cd /opt/sao-photo-service/photo-service && tar -xzf /tmp/ps.tgz --strip-components=1
```

Then unpack over the target directory (`/opt/sao-photo-service/photo-service`, `/opt/odh-sao`), rebuild and recreate. Before the first extraction make a copy of what is being replaced — that copy is the only rollback for a directory that git does not track.

After unpacking, confirm no CR reached the server:

```sh
grep -rl $'\r' /opt/sao-photo-service/photo-service/src /opt/odh-sao/api | head
```

After the update, the sheet «На штаб» in the Excel export shows the plan in marks: 811 stops, 2 235 pedestrian-crossing points, 10 035 entrances.

## Backup and restore

Daily backup is separate from the legacy jobs:

```sh
PHOTO_SERVICE_COMPOSE_DIR=/opt/sao-photo-service/photo-service \
PHOTO_SERVICE_BACKUP_DIR=/var/backups/sao-photo-service \
/opt/sao-photo-service/photo-service/scripts/backup.sh
```

Before the first real upload, verify `SHA256SUMS` and complete one restore into a disposable Compose project. Restore is destructive for its explicitly named test target and requires `PHOTO_SERVICE_RESTORE_CONFIRM=I_UNDERSTAND_THIS_REPLACES_THE_TEST_DATABASE`.

### Nightly encrypted backups on obhod-sao.ru (`deploy/server-backup/`)

Since 2026-10-12 production is backed up by `server-backup.py`, not by `scripts/backup.sh`. The sources live in `deploy/server-backup/`; on the server they are installed as:

| Repository file | On the server | Run by |
|---|---|---|
| `server-backup.py` | `/opt/sao-recovery/server-backup.py` | `sao-backup-database.timer` (03:30 UTC), `sao-backup-media.timer` (03:46 UTC) |
| `sao_backup_retention.py` | `/opt/sao-recovery/sao_backup_retention.py` | imported by `server-backup.py` |
| `sao-offsite.sh` | `/usr/local/bin/sao-offsite.sh` | `sao-offsite.timer` (04:40 UTC), Google Drive `SAO-backups/` |

Each run writes `/opt/sao-recovery/server-backups/<stamp>-<kind>/sao-<stamp>-<kind>.tar.age` plus `result.json`; `result.json` is written last and marks the copy complete. The server keeps 2 copies of each kind; Google Drive keeps 30 database copies and 1 media copy.

Photos are stored in the photo database (`object_slot_photos`, `object_photo_point_photos`), so every database copy contains all photos and grows by gigabytes a day. On 2026-10-28 the disk filled up overnight: a run died half-way, left 31 GB of unencrypted dumps, PostgreSQL could not checkpoint and the photo service went down with 502. The script now:

- deletes its own directory when a run fails, and removes leftovers of earlier failed runs (only directories that contain nothing but `payload/`, `payload.tar` and the partial `.age`);
- deletes the oldest complete copy before writing a new one, and refuses to start when free space is below twice the last copy plus 30 % growth plus 5 GB;
- streams `tar` into `age`, so no plaintext `payload.tar` is written.

Install an update (back up the old files first, keep the file names):

```sh
cd /opt/sao-recovery
cp server-backup.py server-backup.py.bak-$(date +%Y%m%d)
install -m 0700 /path/to/release/deploy/server-backup/server-backup.py server-backup.py
install -m 0600 /path/to/release/deploy/server-backup/sao_backup_retention.py sao_backup_retention.py
systemctl start sao-backup-database.service && journalctl -u sao-backup-database.service -n 5 --no-pager
ls -la /opt/sao-recovery/server-backups && df -h /
```

`/opt/sao-recovery/daily-databases/` received another, **unencrypted** full dump every day at 05:00 UTC from a job that is neither a systemd timer, a cron entry nor a container on the server (probably a scheduled SSH job from another machine). Until that job is found and switched off at its source, make the directory immutable with `chattr +i /opt/sao-recovery/daily-databases`, so the job fails instead of filling the disk; `chattr -i` reverts it.

If the disk fills up anyway: the database log shows `PANIC: could not write ... No space left on device`. Check `df -h /` and `du -xh / --max-depth=2 | sort -h | tail`, delete the oldest backup copies (never `docker system prune` or volumes), then `$DC restart database` and `$DC restart photo-service`. While the disk is full, `tune2fs -m 0 /dev/mapper/hk-root` gives PostgreSQL the root reserve; put it back with `tune2fs -m 5` afterwards.

## Proxy rollout

1. Back up `/opt/jirajura/deploy/nginx/active.conf.template` and `/opt/jirajura/docker-compose.prod.yml`.
2. Add the `location /photo-api/` block from `deploy/nginx/sao-photo-location.conf` to the existing TLS server.
3. Add only the external `sao-photo-service-edge` network to the existing `proxy` service and mount no database/media volumes into it.
4. Recreate only the proxy container, run `nginx -t`, then verify `https://obhod-sao.ru/photo-api/healthz` and the existing `/odh-api/` health separately.
5. Roll back by restoring the two saved proxy files and recreating only `jirajura-proxy-1`; stop the new Compose project only if the API itself is unhealthy.

## Monitoring

Install `deploy/photo-service-cron.example` with executable scripts (`chmod 750 photo-service/scripts/*.sh`) and keep logs outside the application volume. `monitor.sh` checks the dedicated health endpoint, running container and media free space; below 20% it exits with alert and does not delete anything.

## Smoke checklist

- `/photo-api/healthz` returns `service=sao-photo-service`, `database=connected`.
- Invalid credentials are rejected; successful login returns an httpOnly `SameSite=None; Secure` cookie and a bearer token for browsers that block third-party cookies.
- Login from the atlas origin (`https://hainox.github.io`) keeps the session; a successful sign-in does not count towards the failed-attempt limit.
- District account cannot read another district or unassigned objects.
- Photo without GPS is rejected with `gps_required`.
- JPEG/PNG/WebP magic bytes are checked; HEIC, spoofed MIME and files over 20 MB are rejected.
- Repeating an upload with the same `Idempotency-Key` does not create a second photo and returns the stored geo verdict.
- Upload without a `thumbnail` part still works; the response reports `thumbnail: false`.
- Prefecture can review a pending photo; summary counts confirmed photos only.
- Excel contains object rows, photo metadata and embedded previews; PDF contains the short summary and risks. Both print the report date and the dataset version.
- Photo content and both exports are reachable from the atlas origin (CORS headers present).
- Existing `/odh-api/` routes and `jirajura` health remain unchanged.

### Вход районов без пароля (2026-10-24)

Районные `district_editor` с действующей учёткой и известным районом САО (включая АвД САО) входят без пароля. Учётные записи префектуры продолжают проверять пароль. Название района — публичный выбор, а не подтверждение личности: любой посетитель может действовать в рамках районных прав. Серверные проверки объектов, приёмки и назначения точек сохранены.

Для установленного сервера `deploy/enable-district-passwordless.py` проверяет восстановленную БД и структуру обработчика, сохраняет два заменяемых файла в каталоге `passwordless-rollback-*`, проверяет синтаксис Node и меняет только политику входа. Запустите его из закреплённого коммита, затем пересоберите только фотослужбу с обоими compose-файлами. Данные, пароли и сессии в БД не изменяются.

Проверка после развёртывания: Коптево входит без пароля, префектура без пароля получает 401, после районного входа доступны фотослоты, а назначение точек и приёмка недоступны. Слияние в main обновляет Pages, но само по себе не обновляет фотослужбу.

Проверка зависимостей 2026-10-24: устранена GHSA-27r3-jxmh-p828 обновлением body-parser 2.3.0 → 2.4.0 и требуемого qs 6.16.0 → 6.16.1 в lockfile. npm audit не выявляет уязвимостей. Серверный скрипт меняет только вход; обновлённый lockfile устанавливается при полном развёртывании из репозитория.

### Retiring entrance shooting points by a list (`scripts/retire-district-photo-points.js`)

When the prefecture sends a list of entrance shooting points to delete («Точка съёмки 12.362», «9.215» — district number, dot, point number), put the list into `photo-service/scripts/retire-lists/` and ship the scripts as above. The script does what the «Удалить» button in the point card does: the point gets `retired_at`, its photos stay in the database, and every point is written to `audit_log` under the given prefecture account. A point is retired only in the district its number belongs to. Only points of the working layer, the ones the district map shows, are retired: prefecture archive points (created before 2026-10-23 11:00) and imported NextGIS/GPKG sets often reuse the same numbers, so they are listed in the dry run and left as they are. The dry run lists how many points will go per district, numbers that were not found or are already retired, and points that still have a photo under review or accepted:

```sh
cd /opt/sao-photo-service/photo-service
DC="docker compose -p sao-photo-service -f compose.yaml -f compose.recovery.yaml"
$DC build photo-service
$DC run --rm photo-service node scripts/retire-district-photo-points.js --list=scripts/retire-lists/2026-10-29-entrances.txt
$DC run --rm photo-service node scripts/retire-district-photo-points.js --list=scripts/retire-lists/2026-10-29-entrances.txt --actor=PREFECTURE_LOGIN --apply
```

No restart is needed; the district maps stop showing the points on the next refresh.
