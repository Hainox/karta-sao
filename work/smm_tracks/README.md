# GPS-треки СММ (необязательный каталог)

Сюда кладутся **реальные** треки эталонных дворов после натурных заездов.
Генератор `work/build_smm_routes_overlay.py` использует их автоматически;
если файлов нет — оверлей остаётся схематичным (прежнее поведение).

## Форматы файлов

Имена строго по варианту: `dt1`, `dt2`, `dt3`, `dt4`, `dt5`.

| Файл | Содержимое | Результат в smm_routes.geojson |
|---|---|---|
| `dt1.gpx` … `dt5.gpx` | Трек движения машины по маршруту (GPX 1.1, любые `<trkseg>`) | `route_direction` = LineString фактического маршрута; азимут рассчитан по сегментам трека |
| `dt1.nozzle.json` … | Замеры направления выброса: точки с азимутами | `nozzle_direction` с полем `nozzle_track` — список `[lng, lat, bearing]` |

### Пример route-трека (`dt1.gpx`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="gnss" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>dt1</name><trkseg>
    <trkpt lat="55.79450" lon="37.51200"/>
    <trkpt lat="55.79450" lon="37.51240"/>
    <trkpt lat="55.79455" lon="37.51280"/>
    <trkpt lat="55.79460" lon="37.51320"/>
  </trkseg></trk>
</gpx>
```

### Пример nozzle-замера (`dt1.nozzle.json`)

Короткий формат — массив точек:

```json
{
  "points": [
    [37.51246, 55.79437, 350],
    [37.51260, 55.79437, 355],
    [37.51275, 55.79437, 5]
  ]
}
```

Либо FeatureCollection из Point-фич со свойством `bearing` (градусы, 0 = север):

```json
{
  "type": "FeatureCollection",
  "features": [
    { "type": "Feature",
      "properties": { "bearing": 350 },
      "geometry": { "type": "Point", "coordinates": [37.51246, 55.79437] } }
  ]
}
```

## Пересборка

```bash
python work/build_smm_routes_overlay.py
# или явно:
python work/build_smm_routes_overlay.py --tracks-dir work/smm_tracks --out smm_routes.geojson
```

Статус каждого вектора в выходном файле говорит, что использовано:
`GPS-трек (N точек)` / `Замер направлений выброса: N точек` — реальные данные;
`Схематично…` — замер ещё не проводился. Схема с метками направления
(`smm/dt*.svg`) остаётся эталоном до появления треков.