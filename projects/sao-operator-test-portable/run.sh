#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

PORT=${PORT:-8765}
HOST=${HOST:-0.0.0.0}

printf 'Оператор САО: http://127.0.0.1:%s/operator\n' "$PORT"
printf 'Демо-вход: demo@local.test / demo\n'
exec python3 server.py --host "$HOST" --port "$PORT"
