# Checkpoint: SAO photo service

Дата: 2026-09-15  
Рабочая копия: `C:\Users\dmitr\Documents\Codex\2026-08-26\new-chat\work\karta-sao-photo-service`  
Исходную папку `C:\Users\dmitr\Documents\Codex\2026-08-26\new-chat\work\karta-sao` не изменять.

## Состояние Git

- Ветка: `photo-service-centralization`.
- Переданная базовая точка: `841ce4f`.
- Последний коммит реализации: `ddc6c7d feat: implement isolated photo service foundation`.
- Предыдущий локальный коммит: `795bf33 feat: bootstrap isolated photo service helpers`.
- После добавления этого checkpoint-файла сделать отдельный checkpoint-коммит; не делать reset и не переключать ветку вслепую.
- Секреты, `.env`, пароли и ключи в репозиторий не добавлялись.

## Утверждённые решения пользователя

- Индивидуальные заранее подготовленные учётные записи; общий пароль `12345678` в новую службу не переносить.
- Роли: районная учётка видит только свой район; префектурная — сводку САО и unassigned.
- GPS обязателен для отправки фото. Без широты и долготы сервер отвечает `gps_required`.
- Геоконтроль: номинальный радиус 15 м, допуск ±5 м; до 15 м `within_radius`, 15–20 м `within_tolerance`, свыше 20 м `risk`. Для нескольких точек используется ближайшая зарегистрированная точка; это приближение, не проверка контура.
- Нормы подтверждённых фото: остановка 1, ПП 2, вход 1.
- Статусы выполнения: красный `<33%`, жёлтый `33–<66%`, зелёный `≥66%`.
- Выгрузка: полный Excel с объектами, метаданными и фотографиями; краткий PDF со сводкой.
- Эталонные фотографии бессрочны; прочие удаляются только вручную при нехватке места после отдельной проверки.

## Что уже сделано

1. `photo-service/` — отдельное Node.js 24 приложение с PostgreSQL, Compose project/network/volumes и namespaced `PHOTO_SERVICE_DB_*`. Старые БД, сеть, тома, секреты и `/api/health` не используются.
2. `migrations/001_initial.sql` — пользователи, сессии, объекты, фотографии, идемпотентность, аудит.
3. Серверные маршруты: `/healthz`, `/auth/login`, `/auth/logout`, `/auth/me`, `/objects/resolve`, `/photos` GET/POST, выдача `/photos/:id/content`, review/delete, `/reports/summary`, `/reports/export.xlsx`, `/reports/export.pdf`.
4. Пароли хешируются scrypt; сессия — случайный opaque token в httpOnly cookie; login rate limit — локальный для процесса.
5. Upload: multipart, JPEG/PNG/WebP, magic-byte проверка, лимит 20 МБ, безопасный UUID storage key, отдельный media volume, `Idempotency-Key`, GPS и raw distance в PostgreSQL.
6. `scripts/import-object-maps.js --dry-run` читает встроенные наборы трёх карт и `districts.geojson`; ПП группируется по `odh_id + district`, координаты сохраняются как reference points. Поддержан `--apply` и `--source-root=...`.
7. Три standalone-карты переведены с IndexedDB на API фотослужбы: вход, серверные счётчики/галерея, обязательный GPS перед отправкой, повторяемая отправка. CSV для Яндекс-карт сохранён.
8. `dev/BuildSpec.md`, `dev/Data-Audit.md`, `dev/ProjectLog.md`, `tasks/plan.md` сохранены в рабочей копии. `dev/Vision.md` в базе отсутствует; это зафиксировано, не выдумывалось.

## Подтверждённые проверки

- `npm test`: 34/34.
- Inline JavaScript всех трёх карт разобран без синтаксических ошибок.
- `npm audit signatures`: 132 пакета и 4 attestations проверены.
- Локальный изолированный Docker smoke: миграция 001 применена; новый `/healthz` вернул HTTP 200 `database=connected`; приложение работало от UID 1000 и имело writable отдельный media volume; временные контейнеры, сеть и тома удалены.
- Import dry-run: 812 строк остановок, 2235 строк ПП, 10035 входов; 812 stop, 428 reportable PP (427 назначенных пар + 1 unassigned), 10035 entrance; 7 unassigned (6 остановок и один PP).

## Непроверено / осталось

- Production не развёрнут, SSH/push не выполнялись. Нет подтверждённого host/user/key и выделенного production-контура новой службы.
- Не сделаны production backup/restore scripts и rehearsal, внешняя backup target/SLA, мониторинг/алерты и обратимый nginx/proxy rollout.
- Реальная PostgreSQL загрузка объектов и upload/review/export E2E ещё не прогонялись на тестовой БД с fixture-данными.
- Ручная проверка ПК 1280×800 и телефона 390×844 ещё не проведена.
- `npm audit --omit=dev` сообщает 2 moderate advisory через декларацию `exceljs -> uuid <11.1.1`; в lock установлен `uuid 11.1.0` override. `npm audit fix --force` не применять вслепую: он предлагает breaking downgrade ExcelJS. Перед production нужен security verdict/альтернативный экспортный пакет.
- Нужно отдельно проверить производительность полного Excel с большим числом фотографий и отсутствие OOM.
- После получения решения по outliers/семантическому ключу подъезда повторить import и зафиксировать source version.

## Как продолжить на другом устройстве

1. Перенести этот репозиторий или Git bundle вместе с этим файлом. Не переносить `photo-service/.env`, реальные media и `node_modules`.
2. Перейти в рабочую копию и выполнить:

   `git status --short --branch`

   `git log -3 --oneline`

   `npm --prefix photo-service ci --ignore-scripts --no-audit --no-fund`

   `npm --prefix photo-service test`

3. Перед любым production-действием прочитать `dev/BuildSpec.md`, затем `dev/ProjectLog.md`, затем этот checkpoint. Проверить выделенные production path/network/volumes/secrets/backups; старый ODH Compose не переиспользовать.
4. Создать локальную учётку только после `npm run migrate`; пароль вводить скрыто через `npm run create-user -- --email ... --display-name ... --role ...` без передачи пароля в аргументах.
5. Для переноса без удалённого Git можно создать bundle на исходном устройстве:

   `git bundle create ..\sao-photo-service-transfer.bundle --all`

   На другом устройстве:

   `git clone sao-photo-service-transfer.bundle karta-sao-photo-service`

   После клонирования создать новую рабочую копию и проверить ветку/HEAD по разделу выше.

Не считать наличие старой БД, старого `/api/health` или локального smoke доказательством готовности новой фотослужбы принимать реальные файлы.
