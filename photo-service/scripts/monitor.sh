#!/bin/sh
set -eu
COMPOSE_DIR=${PHOTO_SERVICE_COMPOSE_DIR:-$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)}
PROJECT=${PHOTO_SERVICE_COMPOSE_PROJECT:-sao-photo-service}
PORT=${PHOTO_SERVICE_HOST_PORT:-8788}
cd "$COMPOSE_DIR"
health=$(curl --fail --silent --show-error --max-time 5 "http://127.0.0.1:$PORT/healthz")
printf '%s\n' "$health" | grep -q '"status":"ok"'
docker compose -p "$PROJECT" ps --status running --services | grep -qx 'photo-service'
free_percent=$(docker compose -p "$PROJECT" exec -T photo-service sh -c "df -P /var/lib/sao-photo-service/media | awk 'NR==2 {gsub(/%/,\"\",\$5); print 100-\$5}'" | tr -d '\r')
case "$free_percent" in
  ''|*[!0-9]*) echo 'Could not read media free space' >&2; exit 1 ;;
esac
if [ "$free_percent" -lt 20 ]; then
  echo "ALERT: media free space ${free_percent}% (<20%); stop uploads and review non-reference purge." >&2
  exit 2
fi
printf 'photo-service healthy; media free %s%%\n' "$free_percent"
