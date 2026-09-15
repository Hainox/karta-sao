# Отдельная фотослужба САО

Изолированный Node.js 24 + PostgreSQL сервис для фотофиксации остановок, ПП и входов. Он не использует старую ODH/JiraJura БД, сеть, тома, секреты или `/api/health`.

## Контракт

- Нормы подтверждённых фото: остановка 1, ПП 2, вход 1.
- GPS обязателен для отправки. Без координат сервер отвечает `gps_required`.
- 0–15 м — `within_radius`; >15–20 м — `within_tolerance`; >20 м — `risk`. Для нескольких точек берётся ближайшая зарегистрированная точка; это приближение, а не проверка контура.
- При отсутствии/точности GPS выше 5 м фото остаётся на ручной проверке. Геолокация телефона не является криптографическим доказательством.
- JPEG/PNG/WebP до 20 МБ. Имя хранения генерируется UUID; исходное имя сохраняется только как метаданные.
- Клиент вместе с фото отправляет необязательный кадр `thumbnail` (320 px, до 512 КБ). Excel встраивает именно его: встраивание 11 701 оригинала даёт книгу около 870 МБ и пик памяти 3,9 ГБ, миниатюры — около 130 МБ и 1,1 ГБ. Оригинал остаётся на сервере и открывается в карточке объекта.
- Excel — полный реестр с миниатюрами и метаданными; PDF — краткая сводка. Оба отчёта печатают дату формирования и версию набора объектов.
- Статусы в отчётах — словами («Красный», «Жёлтый», «Зелёный»), типы объектов — «Остановки», «ПП», «Подъезды». Внутренние коды `low`/`stop` в отчёты не попадают.

## Отчёты

Краткий PDF собирается как сводка с диаграммами, полный Excel — как рабочий реестр с визуализацией прямо в ячейках.

PDF, страница 1:

- крупный процент выполнения, цветной значок статуса словом и шкала выполнения;
- ключевые числа одной строкой: с фото, без фото, на проверке, риск GPS;
- составная полоса «Состояние объектов»: выполнено, частично, без фото;
- полосы «Выполнение по типам объектов» с процентом, долей и словесным статусом;
- столбцы «Динамика загрузки, 14 дней» — фотографии по дням (по UTC) и накопленный итог.

PDF, страница 2 появляется, когда в выборке больше одного района: полосы по районам, отсортированные по выполнению, где «Без района» идёт последней строкой.

Excel:

- «Сводка» — ключевые показатели, полоса в ячейке у строки «Выполнение»;
- «Районы» — разрез по районам с полосами по выполнению и числу завершённых объектов;
- «Динамика» — дни, загрузка за день и накопленный итог с полосами;
- «Объекты» и «Фотографии» — полные реестры с метаданными и встроенными миниатюрами.

Полосы — это родное условное форматирование Excel (`dataBar`), а не картинки: они масштабируются, печатаются и остаются читаемыми в любой версии.

## PDF и шрифт

PDFKit со встроенным Helvetica не умеет кириллицу: текст пишется в WinAnsi без таблицы `ToUnicode`, поэтому отчёт и выглядел неверно, и копировался абракадаброй. В комплекте лежит `assets/fonts/PT_Sans-Web-Regular.ttf` (PT Sans, ParaType, OFL — см. `OFL.txt` рядом), он регистрируется перед выводом текста.

Признак исправности: в готовом PDF стоит `Type0`/`Identity-H` со встроенным `FontFile2` и есть `/ToUnicode`, а извлечённый текст читается по-русски. Проверить на образце:

```sh
node scripts/pdf-sample.js
python -c "from pypdf import PdfReader; print(PdfReader('<путь к sample.pdf>').pages[0].extract_text())"
```

Dockerfile копирует `assets`, поэтому шрифт попадает в образ. Если PDF снова начнёт «сыпаться» после пересборки, первым делом проверьте, что `assets` не выпал из образа.

## Учётные записи

```sh
npm run create-user -- --login "Аэропорт" --display-name "Аэропорт" --role district_editor --district "Аэропорт"
node scripts/set-password.js --login "Аэропорт"
node scripts/rotate-accounts.js --out /out/accounts.xlsx
```

Пароли в репозитории не хранятся. `set-password.js` меняет пароль скрытым вводом и отзывает активные сессии учётки. `rotate-accounts.js` задаёт всем активным учёткам новые случайные пароли, проверяет вход через публичный API и складывает таблицу учёток в xlsx; пароли печатаются только в файл.

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
npm run create-user -- --login "Аэропорт" --display-name "Аэропорт" --role district_editor --district "Аэропорт"
npm run import-maps -- --dry-run
npm run import-maps -- --apply
node scripts/excel-load-test.js --objects=11701 --image=<файл-миниатюры-320px>
```

Импорт читает наборы из `object-maps/data/*.json` и сверяет SHA-256 каждого файла с `object-maps/data/manifest.json`; при расхождении импорт останавливается. Диагностика dry-run перечисляет все объекты без района построчно, а применение записывает прогон в `import_runs`.

Пароль вводится скрыто и не передаётся в аргументах; минимальная длина — 12 символов. Для совместимости старых клиентов `--email` и JSON-поле `email` принимаются как алиасы логина. Для префектуры используется `--role prefecture_admin` без `--district`. Реальные production-учётки создавать только после отдельной проверки хоста и резервной копии.

Импорт по умолчанию выполняется в dry-run. Для контейнера, где исходные карты смонтированы отдельно, использовать `--source-root=/sources` — каталог должен содержать `object-maps/data/` и `districts.geojson`.

## HTTP API

- `GET /healthz` — только доступность этой PostgreSQL; не legacy health.
- `POST /auth/login` — логин может быть названием района, JSON принимает `login` (старый алиас `email`). Возвращает `token` вместе с httpOnly cookie: агломератор карт живёт на другом домене, и на браузерах, режущих сторонние cookie, клиент отправляет `Authorization: Bearer`.
- `POST /auth/logout`, `GET /auth/me` — сессия в httpOnly cookie; сервер также принимает bearer-токен.
- `GET /objects/resolve?datasetId=...&sourceId=...` — авторизованный поиск ключа.
- `GET /photos?datasetId=...&sourceId=...` — галерея в пределах роли.
- `POST /photos` — multipart `file`, необязательный `thumbnail`, `datasetId`, `sourceId`, `performer`, обязательные `gpsLat`/`gpsLon`; заголовок `Idempotency-Key` обязателен. Повтор с тем же ключом не создаёт второе фото и возвращает сохранённый геостатус.
- `GET /photos/:id/content` — защищённая выдача файла; отдаёт CORS-заголовки, потому что карты читают байты авторизованным запросом.
- `PATCH /photos/:id/review` и `DELETE /photos/:id` — только `prefecture_admin`; эталонные фото удалить нельзя.
- `GET /reports/summary` — сводка в пределах роли: район видит только свой район, префектура — САО, любой район и строку «Без района».
- `GET /reports/export.xlsx` и `/reports/export.pdf` — **только `prefecture_admin`**, иначе `403 prefecture_role_required`. Районная учётка выгрузок не имеет вообще: её единственное действие — `POST /photos`.

## Роли

- `district_editor` — одна учётка на район, логин — название района. Только загрузка фото в своём районе; список, очередь и метки на карте ограничены районом учётки, выгрузок нет, скачивания файла фото тоже нет.
- `prefecture_admin` — верхний уровень: полная сводка САО, строка «Без района», выгрузки Excel и PDF, проверка и отклонение фиксаций, удаление неэталонных фото. Логин production-учётки — «Префектура».

## Config

- `PHOTO_SERVICE_COOKIE_SAMESITE` — `lax` (локально и same-origin) или `none` (production: атлас на GitHub Pages, служба на obhod-sao.ru). Значение `none` принудительно включает `Secure`, иначе браузер отбросит cookie.
- `PHOTO_SERVICE_ALLOWED_ORIGINS` — список origin через запятую для CORS. Origin, которого нет в списке, получает 403; без этого списка браузер не отправит ни сессию, ни запросы карт.
- Вход ограничен по числу **неудачных** попыток (10 за 15 минут на адрес). Районный офис сидит за одним внешним адресом, поэтому успешные входы счётчик не увеличивают.

## Production rollout

Целевой каталог: `/opt/sao-photo-service`; Compose project: `sao-photo-service`; приватные volumes: `sao-photo-service_photo-service-postgres-data` и `sao-photo-service_photo-service-media`; отдельная сеть `sao-photo-service-edge` используется только для связи API с reverse-proxy. PostgreSQL остаётся только в Compose default network.

До первого включения:

1. Сохранить старую конфигурацию reverse-proxy и отдельный backup новой службы.
2. В production `.env` задать `PHOTO_SERVICE_COOKIE_SAMESITE=none` (атлас живёт на другом домене) и `PHOTO_SERVICE_ALLOWED_ORIGINS=https://hainox.github.io,https://obhod-sao.ru`; `PHOTO_SERVICE_COOKIE_PATH=/photo-api`.
3. Создать внешнюю сеть `docker network create sao-photo-service-edge`.
4. Применить `node scripts/migrate.js` (миграции 001–003), затем `node scripts/import-object-maps.js --apply` с источниками карт: каталог `--source-root` должен содержать `object-maps/data/` и `districts.geojson`.
5. Создать согласованные районные учётки через `create-user.js`; логин — название района, пароль вводится скрыто и должен иметь минимум 12 символов. Общие пароли короче этого порога запрещены.
6. Запустить `/opt/sao-photo-service/photo-service/scripts/backup.sh`, проверить `SHA256SUMS`, затем выполнить тестовый restore в отдельном Compose project.
7. Подключить `deploy/nginx/sao-photo-location.conf` в TLS server старого proxy и добавить proxy-контейнеру только сеть `sao-photo-service-edge`; старые ODH/JiraJura services не менять.
8. Проверить health, login, upload с GPS, повтор по тому же `Idempotency-Key`, review, выдачу фото, summary, Excel и PDF. При ошибках вернуть предыдущий proxy template и остановить только новый Compose project.

Backup-скрипт не выполняет автоматическую очистку. При свободном media ниже 20% `monitor.sh` завершится с alert; удаление неэталонных файлов — отдельная подтверждённая операция.

## Проверки

`npm test` покрывает конфигурацию, health, нормы/пороги, geo tolerance, auth, ограничение входа, multipart magic-byte (включая кадр `thumbnail`), storage traversal и агрегацию отчёта. CI выполняет тесты, `npm audit --audit-level=high --omit=dev`, подписи npm, проверку импорта и Docker build. Override `uuid` закреплён на 11.1.1: `npm audit --omit=dev` показывает 0 уязвимостей, breaking `audit fix --force` не применялся.

Нагрузочная проверка выгрузки:

```sh
node scripts/excel-load-test.js --objects=11701 --image=<preview.jpg>
```

Измерено: 11 701 объект с миниатюрой 320 px — 130 МБ, 13 с, пик RSS 1,1 ГБ; районный объём 730 объектов — 16 МБ, 1,5 с. Полноразмерные оригиналы дают 872 МБ и пик 3,9 ГБ, поэтому в книгу встраивается только миниатюра.

Браузерная проверка страницы фотофиксации (нужны поднятый сервис и статический сервер репозитория):

```sh
cd ../odh-map && node tests/static-server.mjs &
PHOTO_API_BASE=http://127.0.0.1:8791 PHOTO_DISTRICT_LOGIN=Аэропорт PHOTO_DISTRICT_PASSWORD=... node tests/photo-atlas.e2e.mjs
```

Она проверяет вход, сводку, реестр, обязательный GPS и исполнителя, повтор отправки без дубля, подпись фото с точностью и дистанцией, выгрузки Excel и PDF, ограничения роли района, очередь на телефоне, размеры целей нажатия и единственную карточку фотофиксации в атласе.

После выката тот же набор проверок доступен против production в режиме только чтения (фиксации не создаются):

```sh
cd ../odh-map
PHOTO_DISTRICT_LOGIN=Аэропорт PHOTO_DISTRICT_PASSWORD=... node tests/photo-atlas-live.mjs
```

Он открывает опубликованную страницу, входит районной учёткой и подтверждает, что кросс-доменная сессия и сводка работают на живом домене.
