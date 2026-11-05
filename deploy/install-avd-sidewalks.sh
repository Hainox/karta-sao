#!/usr/bin/env bash
# Run from the release package or repository. Changes only the photo-service.
set -euo pipefail
root=$(cd -- "$(dirname -- "$0")/.." && pwd)
cd /opt/sao-photo-service/photo-service
dc=(docker compose -p sao-photo-service -f compose.yaml -f compose.recovery.yaml)
adapter=src/tpu-points/photo-service-points-adapter.js
layer=src/tpu-points/sidewalk-test-layer.js
photos=src/tpu-points/avd-sidewalk-photos.js
migration=migrations/024_avd_sidewalk_test_photos.sql
files=("$adapter" "$layer" "$photos" "$migration")
hash() { sha256sum "$1" | cut -d ' ' -f1; }
fail() { echo "$1" >&2; exit 1; }
test -f compose.recovery.yaml
for file in "${files[@]}"; do test -f "$root/photo-service/$file"; done
[[ $(hash assets/sidewalk-test-points.json) == b7e0e2775cf3a6e6eedd8ed24b7c61e2242970173554130d1968a4aef60d8165 ]] ||
  fail 'Каталог на сервере не совпадает с проверенным Excel.'
[[ $("${dc[@]}" exec -T photo-service printenv PHOTO_SERVICE_DB_NAME) == sao_photo_recovery_20261008 ]] ||
  fail 'Фотослужба подключена к другой БД. Установка остановлена.'
check_source() {
  local file=$1 expected=$2 current
  current=$(hash "$file")
  [[ $current == "$expected" || $current == "$(hash "$root/photo-service/$file")" ]] ||
    fail "Файл $file не совпадает с проверенной версией. Установка остановлена."
}
check_source "$adapter" 4d016aeb5b0de88b993cb3ad84509aa24c2444c8ee851ff90c7c70063be93d26
check_source "$layer" a82af01579e9d071398cf93d69822b52c174bfe21138ad44827a0add36ed57d9
for file in "$photos" "$migration"; do
  [[ ! -e $file || $(hash "$file") == "$(hash "$root/photo-service/$file")" ]] ||
    fail "Файл $file уже существует и отличается от пакета."
done
if [[ ${1:-} == --check ]]; then
  echo 'Каталог, БД и исходные файлы прошли проверку. Изменений нет.'
  exit 0
fi
[[ $# == 0 ]] || fail 'Использование: bash deploy/install-avd-sidewalks.sh [--check]'

cid=$("${dc[@]}" ps -q photo-service)
test -n "$cid"
old_image=$(docker inspect -f '{{.Image}}' "$cid")
image_name=$(docker inspect -f '{{.Config.Image}}' "$cid")
backup_dir=/var/backups/sao-photo-service
mkdir -p "$backup_dir"
backup=$(mktemp -d "$backup_dir/avd-sidewalks-XXXXXXXX")
for file in "${files[@]}"; do
  if [[ -f $file ]]; then cp -a --parents "$file" "$backup"; fi
done
started=0
rollback() {
  echo "Установка не прошла проверку. Возвращаем файлы из $backup." >&2
  for file in "${files[@]}"; do
    if [[ -f $backup/$file ]]; then cp -a "$backup/$file" "$file"; else rm -f -- "$file"; fi
  done
  docker tag "$old_image" "$image_name"
  if [[ $started == 1 ]]; then
    "${dc[@]}" up -d --no-deps --no-build --force-recreate photo-service
  fi
}
trap 'trap - ERR; rollback; exit 1' ERR

# Применяем только новую таблицу. Каталог, существующие фото, сессии и правки не заменяем.
"${dc[@]}" exec -T photo-service node --input-type=module -e '
  import {readFileSync} from "node:fs";
  import {Pool} from "pg";
  import {photoServiceDatabaseConfig} from "./src/config.js";
  const pool = new Pool(photoServiceDatabaseConfig(process.env));
  try { await pool.query(readFileSync(0, "utf8")); }
  finally { await pool.end(); }
' < "$root/photo-service/$migration"
for file in "${files[@]}"; do install -m 0644 "$root/photo-service/$file" "$file"; done
"${dc[@]}" build photo-service
started=1
"${dc[@]}" up -d --no-deps --no-build photo-service
curl --retry 8 --retry-delay 2 --retry-all-errors --max-time 8 -fsS https://obhod-sao.ru/photo-api/healthz >/dev/null
"${dc[@]}" exec -T photo-service node --input-type=module -e '
  import assert from "node:assert/strict";
  const base = "http://127.0.0.1:" + (process.env.PHOTO_SERVICE_PORT || 8788);
  const route = "/object-photo-points/sidewalk-test";
  assert.equal((await fetch(base + route + "/avd")).status, 401);
  const login = await fetch(base + "/auth/login", { method: "POST",
    headers: {"Content-Type":"application/json"}, body: JSON.stringify({login:"авд сао",password:""}) });
  assert.equal(login.status, 200);
  const {token,user} = await login.json();
  const headers = {Authorization:"Bearer " + token};
  try {
    assert.equal(user.role, "district_editor");
    assert.equal(user.district.toLowerCase(), "авд сао");
    assert.equal((await fetch(base + route + "?district=" + encodeURIComponent("Аэропорт"), {headers})).status, 403);
    assert.equal((await fetch(base + route + "/avd/queue", {headers})).status, 403);
    const assigned = await fetch(base + route + "/avd", {headers});
    assert.equal(assigned.status, 200);
    const {points} = await assigned.json();
    assert.equal(points.length, 3614);
    assert.equal(points.reduce((n,p) => n+p.slots.length,0), 4219);
    assert.equal(new Set(points.map(p => p.district)).size, 13);
    assert(points.every(p => p.balance.toLowerCase() === "авд сао"));
  } finally {
    await fetch(base + "/auth/logout", {method:"POST",headers});
  }
  console.log("Проверено: АвД входит без пароля, 3 614 точек и 4 219 кадров, приёмка закрыта.");
'
trap - ERR
echo "АвД САО подключено. Резервная копия исходных файлов: $backup"
