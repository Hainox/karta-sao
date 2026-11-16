# Handoff — кабинет оцифровки ДП/СП и МАФ

Дата: 2026-11-16. Состояние `main`: `9ddfb90` (pushed, рабочее дерево чистое).
Проект: отдельный кабинет префектуры САО для оцифровки детских (ДП) и спортивных
(СП) площадок и МАФ, с автосинхронизацией со сводной Google-таблицей
(родитель = площадка, дети = МАФ) и общей/по-районной сводкой для сверки.

## Что сделано (4 фазы)

### 1. Сервер — модуль в photo-service
- Миграция `photo-service/migrations/033_dpsp_maf.sql`: таблицы `dpsp_maf_types`,
  `dpsp_maf_items`, `dpsp_site_checks`, `dpsp_maf_photos`,
  `dpsp_maf_photo_tokens`, `dpsp_maf_thumbs` + справочник из 22 типов МАФ.
  Только создаёт новое, существующие данные не трогает, повторный прогон безопасен.
- Модуль `photo-service/src/tpu-points/dpsp-maf.js`, смонтирован в
  `photo-service-points-adapter.js` по `/object-photo-points/dpsp`.
  Родители — готовые точки `playground_photo_points` (2254 ДП + 838 СП);
  МАФ добавляются как дети по `point_id` (`site_id` в таблице).
- Auth: только роль `prefecture_admin`; без сессии адаптер отдаёт **401**
  (не 403). Единственный маршрут без сессии — превью по токену
  (`GET /dpsp/photo-thumb/:token`), потому что Google Sheets `=IMAGE()` не умеет
  Authorization. Токен отзывается при замене фото/удалении МАФ.
- API (все с сессией, кроме превью):
  | Метод | Путь | Что делает |
  |---|---|---|
  | GET | `/dpsp/summary` | свод: totals sites ≈ 3 092 |
  | GET | `/dpsp/dictionaries` | 22 типа МАФ + 16 районов |
  | GET | `/dpsp/sites` | очередь площадок (фильтры район/вид/статус) |
  | GET | `/dpsp/sites/:id` | карточка площадки с МАФ |
  | POST | `/dpsp/sites/:id/maf` | добавить МАФ |
  | PATCH | `/dpsp/maf/:id` | править МАФ |
  | DELETE | `/dpsp/maf/:id` | удалить МАФ |
  | PUT | `/dpsp/maf/:id/photo` | заменить снимок (5 Мб, jpeg/png/webp) |
  | POST | `/dpsp/sites/:id/check` | отметить «Оцифровано» |
  | GET | `/dpsp/sheet.json` | срез для таблицы (родители + дети + свод) |
  | GET | `/dpsp/photo-thumb/:token` | превью без сессии |
- Тесты `photo-service/test/dpsp-maf.test.js`: `npm test` в `photo-service/` —
  **378 pass / 0 fail** (~30 сек).

### 2. Кабинет — `dp-sp-cabinet/index.html`
Фильтры по району/виду (ДП/СП)/статусу, очередь площадок, на карточке — найденные
МАФ (тип, количество, состояние, комментарий, снимок) и отметка «Оцифровано».
Ссылка «На карте» → `districts/<район>.html?playground=<id>`.
Опубликована на Pages автоматически при пуше (main = production).
URL: `https://hainox.github.io/karta-sao/dp-sp-cabinet/`, карточка добавлена в
`hub/index.html` (раздел «Приёмка фото»).

### 3. Google-таблица — `dev/templates/dpsp-sheet.gs`
Таблица `1l2qhV6Ii5gVGnikhsQDUHAUi8cL8SNiB5IwLFGr0Rjs`, скрипт ставится внутрь
неё (Расширения → Apps Script). Листы: «Площадки» (родители), «МАФ» (дети по
`site_id`), «Сверка» (по площадке: решения, фото, «На карту»), «Свод» (округ +
районы, B9 ≈ 3 092), «Журнал», скрытый `_state`.
Синхронизация автоматическая: триггер `syncSheet` каждые 10 минут
(`everyMinutes(10)` в `installTriggers()`), сессия обновляется сама по
свойствам скрипта `SAO_LOGIN` / `SAO_PASSWORD` (сессии сервера — 8 часов).
Доведённые места шаблона: `ensureSheet` с `headers=null`, `ensureCapacity`
(5 010 / 12 010 строк), `CFG.sheetsCap`, кавычки `'_state'!B3`, onEdit-пересборка
«Сверки», зачистка хвоста I..P, чтение решений одним `getValues`, подпись
состояния МАФ (CONDITIONS), `installCrossFilters()` для B1 («Все районы» +
районы из «Справочников»; вызывается из `installCrossSheet` и после
`writeDictionaries` в `syncSheet`), автоподпись решений только при первом
появлении (`!past.who && !past.when`, `who` пишется только если известен).

### 4. Доки
- `dev/RUNBOOK-ДП-СП-цифровка-МАФ.md` — установка на сервер и в таблицу.
- Раздел «Кабинет оцифровки ДП/СП и МАФ» в `README.md`.
- `ChangeLog.md` — блок 2026-11-16.
- Карточка в `hub/index.html`.

## Коммиты (оба в main, запушены 2026-11-16)

1. **`fc6c345` feat: add dp/sp digitization cabinet with maf records and sheet sync**
   10 файлов, 1511 вставок: `photo-service/src/tpu-points/dpsp-maf.js`,
   `photo-service/migrations/033_dpsp_maf.sql`,
   `photo-service/src/tpu-points/photo-service-points-adapter.js`,
   `photo-service/test/dpsp-maf.test.js`, `dp-sp-cabinet/index.html`,
   `dev/templates/dpsp-sheet.gs`, `dev/RUNBOOK-ДП-СП-цифровка-МАФ.md`,
   `hub/index.html`, `README.md`, `ChangeLog.md`.
2. **`9ddfb90` fix: link sever addresses in sheet review and widen its rows**
   предсуществующие накопленные правки, вынесены отдельно:
   - `dev/templates/sheet-sync.gs` — `viewRows` 300→3000 (на живой таблице
     «Сверка» обрезалась), пункт меню «Адреса → ссылки СЕВЕР ЖКХ»,
     `CFG.sever` = punycode `https://xn----ctbibgy3be7b.xn--p1ai/operator`;
   - `dev/templates/sever-address-links.gs` — новый скрипт
     `linkSeverAddresses()` (rich-text-ссылки в колонке D «Сверки»);
   - `dev/Инструкция_фотофиксация_САО.md` — строка про свод из кабинета
     приёмки районов (`districts/review.html`) в таблице экспортов;
   - `odh-map/tests/exports.spec.js` — таймаут ожидания `#export-register`
     10с → 30с (под параллельной нагрузкой не хватало).

## Диагностика 404 — главное, что нужно знать

- Сервер `/opt/sao-photo-service` — **не git-checkout**, файлы ставятся
  `git archive`. Первый прогон делал `git archive HEAD` — это коммит из
  **локального .git сервера** (устаревший `00cc40e`, без dpsp-модуля), поэтому
  прод отвечал «Cannot GET /object-photo-points/dpsp/sheet.json».
  Правильно: `git fetch origin main` → `git archive origin/main …`.
- «Cannot GET» = Express «маршрут не найден» — запрос дошёл до кода без
  dpsp-роутера. 401 на dpsp-пути — **не доказательство монтирования**:
  catch-all `app.use('/object-photo-points', …)` тоже даёт 401 до 404.
  Критерий монтирования: **валидный токен + 200 на `/dpsp/sheet.json`**.
- Без сессии адаптер отдаёт **401**, а не 403 (это исправлено и в runbook).
- Состояние сервера на момент handoff: бэкап снят
  (`/var/backups/sao-photo-service/photo-service-files-*.tgz`); распаковка
  старого `HEAD` уже перезаписала `src` кодом без dpsp, но процесс в памяти
  держит прежние модули до rebuild+restart; повторная распаковка из
  `origin/main` восстановит файлы.

## Что осталось (по шагам)

### 1. Сервер (команды руками, из исправленного runbook)
```sh
cd /opt/sao-photo-service
git fetch origin main
git archive --format=tar.gz -o /tmp/ps-dpsp.tgz origin/main photo-service/src photo-service/server.js photo-service/scripts photo-service/migrations photo-service/package.json photo-service/package-lock.json
cd photo-service && tar -xzf /tmp/ps-dpsp.tgz --strip-components=1
grep -rl $'\r' src migrations server.js | head   # должно быть пусто

DC="docker compose -p sao-photo-service -f compose.yaml -f compose.recovery.yaml"
$DC build photo-service
$DC run --rm photo-service node scripts/migrate.js   # должно закончиться: 033_dpsp_maf.sql applied
$DC up -d photo-service
```
Бэкап уже снят, строку `tar -czf …` можно пропустить. Оба compose-файла
обязательны (`compose.yaml` + `compose.recovery.yaml`).

### 2. Смоук
```sh
curl -s https://obhod-sao.ru/photo-api/healthz | head -c 200   # database=connected
curl -s -o /dev/null -w '%{http_code}\n' https://obhod-sao.ru/photo-api/object-photo-points/dpsp/summary   # 401
curl -s -o /dev/null -w '%{http_code}\n' https://obhod-sao.ru/photo-api/object-photo-points/dpsp/sheet.json -H "Authorization: Bearer <токен префектуры>"   # 200
```
Затем в кабинете (`dp-sp-cabinet/`) под учёткой префектуры: справочник открыт,
«МАФ, шт.» = 0, список площадок есть.

### 3. Таблица
1. Расширения → Apps Script → вставить `dev/templates/dpsp-sheet.gs` целиком.
2. Прописать свойства скрипта `SAO_LOGIN` / `SAO_PASSWORD` (служебная учётка
   префектуры, раздел 2 runbook).
3. Запустить `installTriggers()` (триггер каждые 10 мин) и
   `installCrossFilters()`, разрешить доступ.
4. «ДП/СП → Обновить сейчас» → в «Журнале» «OK», в «Своде» B9 ≈ 3 092
   (2 254 ДП + 838 СП).

## Проверки репозитория
- `python -m pytest tests -q` из корня: **71 passed**; 2 теста
  (`test_server_backup.py`, `test_stream_backup.py`) не собираются на Windows
  из-за Unix-only `fcntl` — предсуществующее, к фиче не относится; в CI
  (Linux) собираются.
- `npm test` в `photo-service/`: **378 pass / 0 fail**.
- `npm run test:ui` в `odh-map/` (Playwright) — в CI не входит.
- CI гоняет только первые две.

## Нюансы и договорённости
- `main` = production: Pages раздаёт атлас, `hub/`, `odh-map/`, `yards-print/`
  прямо из main, merge = релиз. `photo-service`/`api` деплоятся отдельно.
- Локально страницы требуют `python3 -m http.server 8000`: `file://` блокирует
  GeoJSON-фетч, ключ Яндекса referer-locked на `localhost:8000`.
- GeoJSON порядок координат `[lng, lat]`.
- `object_no` присваивается один раз и не меняется — по нему ссылаются.
- Объект вне всех участков остаётся «Без участка»; исключение — urns без района
  в MAF-экспорте получают район из `districts.geojson` через
  `work/assign_urn_districts.py` с меткой `district_source: "boundary"`.
- Слаги районов совпадают с именами `districts/*.html`; в БД названия без «ё»
  («Хорошевский»).
- Сгенерированные слои руками не правятся: `districts.geojson` — через
  `work/build_districts_boundaries.py` затем `work/apply_water_mask.py`.
- Стиль коммитов: английские conventional, lowercase imperative
  («fix: keep district review usable on mobile…»); русский — только UI,
  README и `ChangeLog.md`. На каждый пользовательски видимый тач — dated
  буллет в ChangeLog.
- Windows/pwsh: `tail` нет — `Select-Object -Last N`; кириллические пути в git
  — в кавычках и с `-c core.quotepath=false` для читаемых диффов; имя файла —
  именно `Инструкция_фотофиксация_САО.md` (не «фотофиксации»).
- Рабочая копия на Windows с CRLF не используется для деплоя — только
  `git archive` (в репо LF).
