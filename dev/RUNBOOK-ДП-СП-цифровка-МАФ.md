# Runbook: кабинет оцифровки ДП/СП и МАФ

Оцифровка детских (ДП) и спортивных (СП) площадок и находящихся на них МАФ:
кабинет префектуры → фотофиксация МАФ → сводная Google-таблица для сверки.

| Компонент | Адрес |
|---|---|
| Кабинет оцифровки | https://hainox.github.io/karta-sao/dp-sp-cabinet/ |
| API | https://obhod-sao.ru/photo-api/object-photo-points/dpsp |
| Сводная таблица | https://docs.google.com/spreadsheets/d/1l2qhV6Ii5gVGnikhsQDUHAUi8cL8SNiB5IwLFGr0Rjs/edit |
| Скрипт таблицы | `dev/templates/dpsp-sheet.gs` |

Роли: работа в кабинете и в таблице — только служебная учётка префектуры
(роль `prefecture_admin`). Родительский объект — площадка из существующей
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
