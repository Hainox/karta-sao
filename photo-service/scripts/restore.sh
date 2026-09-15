#!/bin/sh
set -eu
umask 077

if [ "${PHOTO_SERVICE_RESTORE_CONFIRM:-}" != "I_UNDERSTAND_THIS_REPLACES_THE_TEST_DATABASE" ]; then
  echo 'Refusing restore: set PHOTO_SERVICE_RESTORE_CONFIRM for a disposable test target.' >&2
  exit 2
fi
BACKUP_DIR=${PHOTO_SERVICE_RESTORE_DIR:?Set PHOTO_SERVICE_RESTORE_DIR to one verified backup directory}
COMPOSE_DIR=${PHOTO_SERVICE_RESTORE_COMPOSE_DIR:?Set PHOTO_SERVICE_RESTORE_COMPOSE_DIR to a disposable compose project}
PROJECT=${PHOTO_SERVICE_RESTORE_COMPOSE_PROJECT:-sao-photo-service-restore}
[ -f "$BACKUP_DIR/database.dump" ] && [ -f "$BACKUP_DIR/media.tar.gz" ] && [ -f "$BACKUP_DIR/SHA256SUMS" ]
(cd "$BACKUP_DIR" && sha256sum -c SHA256SUMS)
cd "$COMPOSE_DIR"
docker compose -p "$PROJECT" up -d database photo-service
docker compose -p "$PROJECT" exec -T database dropdb -U sao_photo_service --if-exists sao_photo_service
docker compose -p "$PROJECT" exec -T database createdb -U sao_photo_service sao_photo_service
docker compose -p "$PROJECT" exec -T database pg_restore -U sao_photo_service -d sao_photo_service --no-owner < "$BACKUP_DIR/database.dump"
docker compose -p "$PROJECT" exec -T photo-service tar -xzf - -C /var/lib/sao-photo-service/media < "$BACKUP_DIR/media.tar.gz"
echo 'Restore completed in disposable compose project.'
