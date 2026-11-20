# Runbook: кабинет оцифровки ДП/СП и МАФ

Оцифровка детских (ДП) и спортивных (СП) площадок и находящихся на них МАФ:
кабинет префектуры → фотофиксация МАФ → сводная Google-таблица для сверки.

| Компонент | Адрес |
|---|---|
| Кабинет оцифровки | https://hainox.github.io/karta-sao/dp-sp-cabinet/ |
| API | https://obhod-sao.ru/photo-api/object-photo-points/dpsp |
| Сводная таблица | https://docs.google.com/spreadsheets/d/1l2qhV6Ii5gVGnikhsQDUHAUi8cL8SNiB5IwLFGr0Rjs/edit |
| Скрипт таблицы | `dev/templates/dpsp-sheet.gs` |

Районная учётка с ролью `dpsp_district_editor` даёт доступ к площадкам и МАФ своего
района. Администратор `prefecture_admin` видит все районы, проводит приёмку
и получает сводные выгрузки. Родительский объект — площадка из существующей
фотофиксации ДП/СП (`playground_photo_points`), дочерний — МАФ. Существующие
таблицы и отчёты фотофиксации не изменяются.

## 1. Сервер (obhod-sao.ru)

Миграция `033_dpsp_maf.sql` только создаёт новые таблицы (`dpsp_maf_types`,
`dpsp_maf_items`, `dpsp_site_checks`, `dpsp_maf_photos`, `dpsp_maf_photo_tokens`,
`dpsp_maf_thumbs`) и справочник из 22 типов МАФ. Существующие данные не
затрагиваются, повторный прогон безопасен.

Порядок — как в `deploy/SAO_PHOTO_PRODUCTION_RUNBOOK.md` («Shipping the files»):
файлы ставятся `git archive`, потому что `/opt` — не git-checkout. В архив
обязательно включить `photo-service/migrations`, иначе `migrate.js` не увидит 033.

```sh
cd /opt/sao-photo-service
tar -czf /var/backups/sao-photo-service/photo-service-files-$(date +%F-%H%M).tgz --exclude=photo-service/node_modules photo-service
git fetch origin main
git archive --format=tar.gz -o /tmp/ps-dpsp.tgz origin/main photo-service/src photo-service/server.js photo-service/scripts photo-service/migrations photo-service/package.json photo-service/package-lock.json
cd photo-service && tar -xzf /tmp/ps-dpsp.tgz --strip-components=1
grep -rl $'\r' src migrations server.js | head   # должно быть пусто

DC="docker compose -p sao-photo-service -f compose.yaml -f compose.recovery.yaml"
$DC build photo-service
$DC run --rm photo-service node scripts/migrate.js
$DC up -d photo-service
```

`migrate.js` должен закончиться строкой `033_dpsp_maf.sql applied`.

Смоук-проверки:

```sh
curl -s https://obhod-sao.ru/photo-api/healthz | head -c 200          # database=connected
curl -s -o /dev/null -w '%{http_code}\n' https://obhod-sao.ru/photo-api/object-photo-points/dpsp/summary   # 401 без сессии
curl -s -o /dev/null -w '%{http_code}\n' https://obhod-sao.ru/photo-api/object-photo-points/dpsp/summary \
  -H "Authorization: Bearer <токен префектуры>"                        # 200, totals: sites = число неснятых точек базы
```

После входа служебной учётки в кабинете должен открыться справочник
(«МАФ, шт.» = 0) и список площадок; `GET /dictionaries` отдаёт 22 типа МАФ
и 16 районов.

## 2. Служебная учётка префектуры

Если отдельной учётки для оцифровки нет, создайте её штатным порядком
(скрытый ввод пароля, по одному; см. «First install» в
`deploy/SAO_PHOTO_PRODUCTION_RUNBOOK.md`). Роль — `prefecture_admin`.
Логин и пароль понадобятся в шаге 4 (свойства скрипта таблицы).

### Районные учётки ДП/СП

Выкатите фотослужбу и примените миграцию `036_dpsp_district_accounts.sql`
перед выдачей доступа. Создайте по одной учётке на район с отдельным паролем.
На рабочем сервере используйте оба файла Compose из инструкции фотослужбы.

```sh
$DC run --rm photo-service node scripts/create-user.js \
  --login 'dpsp.koptevo' --display-name 'ДП/СП · Коптево' \
  --role dpsp_district_editor --district 'Коптево'
```

Введите пароль через скрытое приглашение. Проверьте, что районная учётка видит одну
районную очередь, может отправить объект на приёмку и получает отказ при
открытии чужой площадки или страницы приёмки. У администратора проверьте
выбор районов и приёмку.

Если выданные логины и пароли уже сведены в файл, учётки можно создать и
починить одной командой. Файл — таблица без заголовка: логин, район, пароль
через табуляцию или точку с запятой; в командной строке паролей нет.

Контейнер фотослужбы работает с `read_only: true`, поэтому `docker compose cp`
в него падает с `container rootfs is marked read-only`, а образ мог быть собран
раньше скрипта. Запускайте скрипт одноразовым контейнером и подкладывайте файлы
mount'ом — запись в контейнер не нужна:

```sh
cd /opt/sao-photo-service
git fetch origin main
git archive origin/main photo-service/scripts/repair-dpsp-accounts.js | tar -x -C /opt/sao-photo-service

# compose-файлы лежат в photo-service/; проверить можно так:
# docker inspect sao-photo-service-photo-service-1 \
#   --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
cd /opt/sao-photo-service/photo-service
DC="docker compose -p sao-photo-service -f compose.yaml -f compose.recovery.yaml"

$DC run --rm --no-deps --user root \
  -v /opt/sao-photo-service/photo-service/scripts/repair-dpsp-accounts.js:/app/scripts/repair-dpsp-accounts.js:ro \
  -v /root/dpsp-accounts.tsv:/tmp/dpsp-accounts.tsv:ro \
  photo-service node scripts/repair-dpsp-accounts.js /tmp/dpsp-accounts.tsv

$DC run --rm --no-deps --user root \
  -v /opt/sao-photo-service/photo-service/scripts/repair-dpsp-accounts.js:/app/scripts/repair-dpsp-accounts.js:ro \
  -v /root/dpsp-accounts.tsv:/tmp/dpsp-accounts.tsv:ro \
  photo-service node scripts/repair-dpsp-accounts.js /tmp/dpsp-accounts.tsv --apply

rm -f /root/dpsp-accounts.tsv
```

`--user root` нужен только чтобы прочитать файл учёток с правами `600`; сам
скрипт ничего не пишет на диск. Образ берётся уже собранный — пересборка после
правки скрипта не нужна; флаг `--no-build` есть не во всех версиях compose CLI
(на сервере он отвечает `unknown flag`), поэтому его не используем.

Если `compose.yaml` не лежит в текущем каталоге (стек могли поднять из другого),
путь к файлам виден по метке контейнера:

```sh
docker inspect sao-photo-service-photo-service-1 \
  --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}'
```

Тогда запуск можно сделать вообще без compose: `/tmp` в контейнере — tmpfs,
туда пишутся скрипт и файл учёток. Скрипт кладётся с расширением `.mjs` (вне
`/app` нет `package.json`, и `.js` Node считает CommonJS), импорты в нём
переводятся на абсолютные пути, а рядом создаётся ссылка на `node_modules`:

```sh
C=sao-photo-service-photo-service-1
sed "s#'../src/#'/app/src/#g" /opt/sao-photo-service/photo-service/scripts/repair-dpsp-accounts.js > /tmp/repair.mjs

docker exec -i "$C" sh -c 'ln -sfn /app/node_modules /tmp/node_modules; cat > /tmp/repair.mjs' < /tmp/repair.mjs
docker exec -i "$C" sh -c 'cat > /tmp/dpsp-accounts.tsv' < /root/dpsp-accounts.tsv

docker exec -i "$C" node /tmp/repair.mjs /tmp/dpsp-accounts.tsv
docker exec -i "$C" node /tmp/repair.mjs /tmp/dpsp-accounts.tsv --apply

docker exec -i "$C" sh -c 'rm -f /tmp/repair.mjs /tmp/dpsp-accounts.tsv /tmp/node_modules'
rm -f /tmp/repair.mjs /root/dpsp-accounts.tsv
```

Без `--apply` скрипт только перечисляет, что изменится: создаст отсутствующие,
вернёт роль `dpsp_district_editor`, район и активность, сбросит несовпадающий
пароль и закроет сессии исправленных учёток. Работающие учётки с этим паролем
остаются без изменений. Строки с неизвестным районом, коротким паролем или
повторным логином останавливают запуск до записи.

## 3. Кабинет (GitHub Pages)

Страница `dp-sp-cabinet/index.html` публикуется из `main` автоматически:
merge в `main` = выкладка (как у остальных страниц атласа). Ничего вручную
деплоить не нужно. Проверить: страница открывается, форма входа принимает
служебную учётку, после входа видны сводка и очередь площадок.

## 4. Таблица (Apps Script)

Установка — один раз, внутри самой таблицы:

1. Открыть таблицу → «Расширения» → «Apps Script».
2. Вставить целиком `dev/templates/dpsp-sheet.gs`, сохранить проект.
3. «Настройки проекта» (шестерёнка) → «Свойства скрипта» → добавить:
   - `SAO_LOGIN` — логин служебной учётки префектуры;
   - `SAO_PASSWORD` — её пароль;
   - `SAO_TOKEN` можно не задавать: скрипт сам получит токен по логину/паролю
     и будет обновлять его, когда сессия истечёт (8 часов).
4. Перезагрузить таблицу → меню «ДП/СП · Оцифровка» → «Собрать структуру».
   Скрипт создаст листы «Свод», «Площадки», «МАФ», «Сверка», «Справочники»,
   «Журнал», «_state» и развернёт их под полный объём (до 5 000 площадок
   и 12 000 МАФ). При первом запуске Google запросит OAuth-права — разрешить.
5. Меню → «Обновить сейчас». «Площадки» наполнятся точками ДП/СП из
   фотофиксации, «МАФ» — найденными МАФ (сначала пусто), «Свод» —
   показателями по округу и районам.
6. Меню → «Включить автообновление (10 мин)».

Что делает скрипт:

- каждые 10 минут тянет `/sheet.json` (площадки, МАФ, справочники) и
  перезаписывает листы; решения на «Сверке» сохраняются по скрытой колонке
  `site_id`;
- при 401 сам перелогинивается по `SAO_LOGIN`/`SAO_PASSWORD`;
- «Сверка» (одна строка = площадка) пересобирается сразу при смене фильтров
  B1/B2 (район; «Все / Только без решения / Только не оцифровано»), из меню
  или при каждой синхронизации; фото площадки подтягиваются `=IMAGE()` по
  неугадываемой ссылке-токену, переход «На карте» ведёт на карту района;
- журнал синхронизаций — лист «Журнал», статус — «Свод» B5.

Проверки после установки:

- «Свод» B9 (всего площадок) равен числу строк `playground_photo_points`
  с `retired_at IS NULL`; на 16.11.2026 — 2 833 (2 043 ДП + 790 СП), B5 = «ok».
  Контуры корневой карты (3 092) и исходные точки фотофиксации (3 042) —
  разные наборы; 209 исходных точек сняты. Подробная сверка и списки:
  `projects/playground-photo-points/work/reconciliation-DP-SP-2026-11-16.md`;
- «Сверка» заполнена, у строк есть кнопка-ссылка «На карте»;
- в колонке «Фото площадки» видно целое превью с сохранением пропорций:
  `IMAGE(...;1)`, строки по 160 px, колонка I — 220 px. Ссылки площадок
  используют `/object-photo-points/playgrounds/photo-thumb/`, ссылки МАФ —
  `/object-photo-points/dpsp/photo-thumb/`.

## 5. Эксплуатация и откат

- Ошибка в «Журнале» с текстом про 401: проверьте `SAO_LOGIN`/`SAO_PASSWORD`
  и повторите «Обновить сейчас» (токен обновится автоматически).
- Превью в таблице перестали открываться: ссылка-токен отзывается при замене
  снимка или удалении МАФ — это штатно; дождитесь следующей синхронизации.
- Объект без привязки к участку остаётся «Без участка» и не приписывается
  к району молча; МАФ добавляется только к существующей площадке.
- Откат кода: вернуть прежний образ (`$DC build` из копии файлов из
  `/var/backups/...`) и `$DC up -d photo-service`. Таблицы 033 не удаляются —
  на работу старого кода они не влияют.
