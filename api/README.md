# Контур обмена правками ОДХ САО

API принимает GeoJSON районов, хранит их в PostgreSQL, фиксирует решения приёмки и отдаёт единый утверждённый GeoJSON для префектуры.

## Запуск

1. В папке `api` выполните `npm install`.
2. Скопируйте `.env.example` в `.env`, задайте `DATABASE_URL` и секрет `JWT_SECRET` длиной от 32 символов.
3. Запустите `npm start`. Миграция создаст таблицы автоматически.
4. Создайте учётные записи через `npm run create-user -- --email editor@example.org --password <пароль> --role district_editor --district Аэропорт`.

Роли: `district_editor` отправляет только закреплённый район; `reviewer` принимает или отклоняет наборы; `prefecture_admin` также выгружает сводку.

## API

- `POST /api/auth/login`
- `POST /api/submissions`
- `GET /api/submissions?status=submitted`
- `PATCH /api/submissions/:id` с `approved` или `rejected`
- `GET /api/exports/approved.geojson`

GitHub Pages исполняет только статические файлы. Для общей базы API должен быть размещён отдельно с PostgreSQL; адрес задаётся в HUD кабинетов.

## Контейнерный запуск

В корне репозитория есть `docker-compose.yml`. Создайте локальный `.env` с
`POSTGRES_PASSWORD` и `JWT_SECRET`, укажите точный адрес публичной карты в
`ALLOWED_ORIGINS`, затем выполните `docker compose up --build`.

API намеренно опубликован только на `127.0.0.1:8787`; для production нужны HTTPS
reverse proxy, резервное копирование PostgreSQL и отдельный секрет.

Для сервера с уже работающим Docker reverse proxy используйте
`docker-compose.production.yml`: API не открывает отдельный порт и получает
alias `odh-sao-api` во внешней proxy-сети. Шаблон location для HTTPS-пути
`/odh-api/` находится в `../deploy/nginx/odh-api-location.conf`.
