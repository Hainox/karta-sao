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

## Backup and restore

Daily backup is separate from the legacy jobs:

```sh
PHOTO_SERVICE_COMPOSE_DIR=/opt/sao-photo-service/photo-service \
PHOTO_SERVICE_BACKUP_DIR=/var/backups/sao-photo-service \
/opt/sao-photo-service/photo-service/scripts/backup.sh
```

Before the first real upload, verify `SHA256SUMS` and complete one restore into a disposable Compose project. Restore is destructive for its explicitly named test target and requires `PHOTO_SERVICE_RESTORE_CONFIRM=I_UNDERSTAND_THIS_REPLACES_THE_TEST_DATABASE`.

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
