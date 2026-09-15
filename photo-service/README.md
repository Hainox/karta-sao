# Отдельная фотослужба САО

Изолированный Node.js 24 + PostgreSQL сервис для фотофиксации остановок, ПП и входов. Он не использует старую ODH/JiraJura БД, сеть, тома, секреты или `/api/health`.

## Контракт

- Нормы подтверждённых фото: остановка 1, ПП 2, вход 1.
- GPS обязателен для отправки. Без координат сервер отвечает `gps_required`.
- 0–15 м — `within_radius`; >15–20 м — `within_tolerance`; >20 м — `risk`. Для нескольких точек берётся ближайшая зарегистрированная точка; это приближение, а не проверка контура.
- При отсутствии/точности GPS выше 5 м фото остаётся на ручной проверке. Геолокация телефона не является криптографическим доказательством.
- JPEG/PNG/WebP до 20 МБ. Имя хранения генерируется UUID; исходное имя сохраняется только как метаданные.
- Excel — полный реестр с фотографиями и метаданными; PDF — краткая сводка.

## Локальный изолированный запуск

```powershell
Copy-Item .env.example .env
# задать в .env случайный PHOTO_SERVICE_DB_PASSWORD; старый пароль не использовать
$env:PHOTO_SERVICE_DB_PASSWORD = 'local-only-random-value'
docker compose -p sao-photo-service-local up --build -d
docker compose -p sao-photo-service-local run --rm photo-service node scripts/migrate.js
Invoke-RestMethod http://127.0.0.1:8788/healthz
docker compose -p sao-photo-service-local run --rm photo-service node scripts/import-object-maps.js --dry-run
```

Для Compose с внешней proxy-сетью заранее создать её только в тестовом окружении:

```powershell
docker network create sao-photo-service-edge
```

Остановка теста с сохранением томов: `docker compose -p sao-photo-service-local down`. Временный smoke должен завершаться `down -v`.

## Команды

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run migrate
npm run create-user -- --email user@example.invalid --display-name "Имя" --role district_editor --district "Аэропорт"
npm run import-maps -- --dry-run
npm run import-maps -- --apply
```

Пароль вводится скрыто и не передаётся в аргументах. Для префектуры используется `--role prefecture_admin` без `--district`. Реальные production-учётки создавать только после отдельной проверки хоста и резервной копии.

Импорт по умолчанию выполняется в dry-run. Для контейнера, где исходные карты смонтированы отдельно, использовать `--source-root=/sources`.

## HTTP API

- `GET /healthz` — только доступность этой PostgreSQL; не legacy health.
- `POST /auth/login`, `POST /auth/logout`, `GET /auth/me` — индивидуальная сессия в httpOnly cookie.
- `GET /objects/resolve?datasetId=...&sourceId=...` — авторизованный поиск ключа.
- `GET /photos?datasetId=...&sourceId=...` — галерея в пределах роли.
- `POST /photos` — multipart `file`, `datasetId`, `sourceId`, `performer`, обязательные `gpsLat`/`gpsLon`; заголовок `Idempotency-Key` обязателен.
- `GET /photos/:id/content` — защищённая выдача файла.
- `PATCH /photos/:id/review` и `DELETE /photos/:id` — только `prefecture_admin`; эталонные фото удалить нельзя.
- `GET /reports/summary`, `/reports/export.xlsx`, `/reports/export.pdf` — отчёт в пределах роли. Нераспределённые объекты видны префектуре отдельной группой и не приписываются району.

## Production rollout

Целевой каталог: `/opt/sao-photo-service`; Compose project: `sao-photo-service`; приватные volumes: `sao-photo-service_photo-service-postgres-data` и `sao-photo-service_photo-service-media`; отдельная сеть `sao-photo-service-edge` используется только для связи API с reverse-proxy. PostgreSQL остаётся только в Compose default network.

До первого включения:

1. Сохранить старую конфигурацию reverse-proxy и отдельный backup новой службы.
2. Создать внешнюю сеть `docker network create sao-photo-service-edge`.
3. Применить `node scripts/migrate.js`, затем `node scripts/import-object-maps.js --apply` с источниками карт.
4. Создать индивидуальные учётки через `create-user.js`; общий пароль запрещён.
5. Запустить `/opt/sao-photo-service/photo-service/scripts/backup.sh`, проверить `SHA256SUMS`, затем выполнить тестовый restore в отдельном Compose project.
6. Подключить `deploy/nginx/sao-photo-location.conf` в TLS server старого proxy и добавить proxy-контейнеру только сеть `sao-photo-service-edge`; старые ODH/JiraJura services не менять.
7. Проверить health, login, upload с GPS, повтор по тому же `Idempotency-Key`, review, выдачу фото, summary, Excel и PDF. При ошибках вернуть предыдущий proxy template и остановить только новый Compose project.

Backup-скрипт не выполняет автоматическую очистку. При свободном media ниже 20% `monitor.sh` завершится с alert; удаление неэталонных файлов — отдельная подтверждённая операция.

## Проверки

`npm test` покрывает конфигурацию, health, нормы/пороги, geo tolerance, auth, multipart magic-byte и storage traversal. CI выполняет тесты, `npm audit --audit-level=high --omit=dev`, подписи npm и Docker build. Moderate advisory ExcelJS/uuid требует отдельного security review; `npm audit fix --force` не применять вслепую.
