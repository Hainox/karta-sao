# ОДХ — экспорт и карты САО

## Каталоги
- `outputs/` — готовые карты, GeoJSON, CSV и отчёты;
- `scripts/` — скрипты сборки и извлечения;
- `tests/` — автоматические проверки;
- `work/` — исходные и промежуточные данные;
- `docs/` — спецификация и план работ.

## Проверка
```powershell
py -3.14 -m pytest tests -q
```

## Пересборка карт
```powershell
py -3.14 scripts/build_sao_maps.py --data-dir work/map_data --output-dir outputs
```
