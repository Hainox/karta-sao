# Рабочая папка «КАРТА»

## 1. Публичная карта дворов САО (корень)
Файлы в корне (`index.html`, `areas.geojson`, `mno.geojson`, `dp.geojson`, `sp.geojson`) — самостоятельный сайт карты дворов САО. Они оставлены в корне, поскольку этот каталог является GitHub Pages-проектом.

## 2. Проекты
- `projects/odh-yandex-export/` — выгрузка ОДХ, исходники сборки, тесты, рабочие данные и готовые файлы карт.
  - результат: `outputs/sao_map_interactive.html` и `outputs/sao_map_print_a3.html`;
  - запуск проверок: `py -3.14 -m pytest tests -q` из каталога проекта;
  - пересборка: `py -3.14 scripts/build_sao_maps.py --data-dir work/map_data --output-dir outputs`.
- `projects/sao-operator-test-portable/` — отдельный переносимый тестовый стенд оператора.

## Правило порядка
Не помещать новые выгрузки в корень. Для ОДХ использовать `projects/odh-yandex-export/outputs`, временные источники — `projects/odh-yandex-export/work`, а код — `projects/odh-yandex-export/scripts`.
