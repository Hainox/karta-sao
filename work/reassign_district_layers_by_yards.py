"""Переносит объекты районных карт в район их двора по реестру АСУ ОДС.

То же правило, что в work/build_district_layer_maps.py, но поверх уже
опубликованных districts/layers/<slug>/*.geojson: полная пересборка требует
исходных слоёв Фазы 1, которых в репозитории нет. Объект, центроид которого
лежит внутри двора из REGISTRY_YARDS, переезжает на карту района этого двора;
manifest.json пересчитывается. По умолчанию — пробный прогон: только список
переносов, файлы не меняются. Повторный запуск с --apply ничего не меняет.

    python work/reassign_district_layers_by_yards.py [--apply]
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_district_layer_maps import LAYERS, OUT_ROOT, SLUGS, YardRegistry, centroid  # noqa: E402

LAYERS_ROOT = OUT_ROOT / "layers"


def main():
    registry = YardRegistry.load()
    keys = [key for key in LAYERS if key != "boundary"]
    collections = {(name, key): json.loads((LAYERS_ROOT / slug / f"{key}.geojson").read_text(encoding="utf-8"))
                   for name, slug in SLUGS.items() for key in keys}
    moved = []
    for (name, key), collection in collections.items():
        stay = []
        for feature in collection["features"]:
            owner = registry.district_at(centroid(feature["geometry"]))
            if owner and owner != name:
                feature["properties"]["district"] = owner
                collections[(owner, key)]["features"].append(feature)
                moved.append((name, owner, key, feature["properties"].get("id")))
            else:
                stay.append(feature)
        collection["features"] = stay
    for row in moved:
        print("%s → %s · %s · %s" % row)
    print(f"Объектов к переносу: {len(moved)}")
    if "--apply" not in sys.argv[1:]:
        print("Пробный прогон: файлы не изменены. Для записи добавьте --apply.")
        return
    # Переписываем только затронутые файлы и в их прежнем виде (часть слоёв сохранена компактно).
    touched = {(old, key) for old, _, key, _ in moved} | {(new, key) for _, new, key, _ in moved}
    for name, key in touched:
        path = LAYERS_ROOT / SLUGS[name] / f"{key}.geojson"
        raw = path.read_text(encoding="utf-8")
        compact = raw.startswith('{"type":')
        text = json.dumps(collections[(name, key)], ensure_ascii=False,
                          separators=(",", ":") if compact else None)
        path.write_text(text + ("\n" if raw.endswith("\n") else ""), encoding="utf-8")
    manifest_path = LAYERS_ROOT / "manifest.json"
    raw = manifest_path.read_text(encoding="utf-8")
    manifest = json.loads(raw)
    for name, key in touched:
        manifest["districts"][name][key] = len(collections[(name, key)]["features"])
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + ("\n" if raw.endswith("\n") else ""),
                             encoding="utf-8")
    print("Записано.")


if __name__ == "__main__":
    main()
