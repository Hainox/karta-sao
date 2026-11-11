# Пешеходные дорожки АСУ ОДС

Слой дорожек и точки съёмки для раздела «Пешеходные дорожки» кабинета приёмки.

## Данные

Источник — реестр АСУ ОДС (`reestr-ogh.mos.ru`), тип «Пешеходная дорожка», только САО.
Геометрия пересчитана из МСК-77 в WGS84. Район проставлен по центроиду полигона.

## Сборка слоя и точек

```powershell
python projects/pedestrian-paths/work/prepare_layer.py `
  --source "C:\путь\к\по_районам" `
  --out photo-service/assets/pedestrian-paths
```

Скрипт пишет 16 файлов `<район>.geojson` для карт и `points.geojson` — точки съёмки.
Короткая дорожка (трасса меньше 100 м) получает одну точку, длинная — точки вдоль
кольца с шагом около 70 м, поднятые на гребень расстояний (середину дорожки).

`photo-service/assets/pedestrian-paths/` в git не хранится: слой закрытый, его
отдаёт фотослужба только префектуре.

## Выкладка

1. Скопировать `photo-service/assets/pedestrian-paths/` на сервер в
   `/opt/sao-photo-service/photo-service/assets/pedestrian-paths/`.
2. Пересобрать службу:
   `docker compose -p sao-photo-service -f compose.yaml -f compose.recovery.yaml build photo-service`
   и `up -d photo-service`.
3. Применить миграцию: `docker compose ... exec -T photo-service node scripts/migrate.js`.
4. Импортировать точки:
   `docker compose ... exec -T photo-service node scripts/import-pedestrian-path-points.js --source=assets/pedestrian-paths/points.geojson --apply`.

Повторный импорт обновляет координаты и адреса по `point_no`, не меняя id и номера.
Исчезнувшие точки снимаются только если у них нет фото.
