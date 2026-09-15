#!/bin/sh
set -eu
umask 077

COMPOSE_DIR=${PHOTO_SERVICE_COMPOSE_DIR:-$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)}
BACKUP_ROOT=${PHOTO_SERVICE_BACKUP_DIR:-/var/backups/sao-photo-service}
PROJECT=${PHOTO_SERVICE_COMPOSE_PROJECT:-sao-photo-service}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="$BACKUP_ROOT/$STAMP"

mkdir -p "$TARGET"
cd "$COMPOSE_DIR"
docker compose -p "$PROJECT" exec -T database pg_dump -U sao_photo_service -d sao_photo_service --format=custom --no-owner > "$TARGET/database.dump"
docker compose -p "$PROJECT" exec -T photo-service tar -czf - -C /var/lib/sao-photo-service/media . > "$TARGET/media.tar.gz"
gzip -t "$TARGET/media.tar.gz"
sha256sum "$TARGET/database.dump" "$TARGET/media.tar.gz" > "$TARGET/SHA256SUMS"
printf '%s\n' "$TARGET" > "$BACKUP_ROOT/latest"
printf 'Created backup %s\n' "$TARGET"
