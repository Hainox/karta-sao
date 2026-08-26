#!/usr/bin/env python3
"""Create verified OZH 2026-2027 layers for the public SAO ODH map."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.parse import quote_plus


def point(name: str, address: str, longitude: float, latitude: float, **properties: object) -> dict:
    query = quote_plus(f"{name}, {address}")
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [longitude, latitude]},
        "properties": {
            "name": name,
            "address": address,
            "coordinate_status": "Адресный центроид",
            "yandex_maps_search": f"https://yandex.ru/maps/?text={query}",
            "2gis_search": f"https://2gis.ru/moscow/search/{query}",
            "google_maps_search": f"https://www.google.com/maps/search/?api=1&query={query}",
            **properties,
        },
    }


def feature_collection(features: list[dict]) -> dict:
    return {"type": "FeatureCollection", "features": features}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    args.output_dir.mkdir(parents=True, exist_ok=True)

    dry_dumps = [
        point("Сухая свалка снега", "ул. Ижорская, вл. 4", 37.5015987, 55.8824532,
              district="Западное Дегунино", area_m2=10500, capacity_m3=42000,
              surface_type="грунт", purpose="ГБУ «АВД» города Москвы",
              verification_status="Подтверждено презентацией КГХ по ОЗП 2026-2027, стр. 45",
              official_evidence="Адресный перечень сухих свалок САО, стр. 45."),
        point("Сухая свалка снега", "пр-д Черепановых, вл. 2-6", 37.548322, 55.847465,
              district="Коптево", area_m2=36000, capacity_m3=200000,
              surface_type="асфальтобетонное покрытие", purpose="ГБУ «АВД» города Москвы; Префектура ЦАО",
              verification_status="Подтверждено презентацией КГХ по ОЗП 2026-2027, стр. 45",
              official_evidence="Адресный перечень сухих свалок САО, стр. 45."),
        point("Сухая свалка снега", "Машкинское ш., вл. 38", 37.3706243, 55.9088869,
              district="Молжаниновский", area_m2=12200, capacity_m3=48800,
              surface_type="грунт", purpose="ГБУ «АВД» города Москвы",
              verification_status="Подтверждено презентацией КГХ по ОЗП 2026-2027, стр. 45",
              official_evidence="Адресный перечень сухих свалок САО, стр. 45."),
    ]
    (args.output_dir / "sao_dry_snow_dumps_wgs84.geojson").write_text(
        json.dumps(feature_collection(dry_dumps), ensure_ascii=False, indent=2), encoding="utf-8"
    )

    confirmed_path = args.output_dir / "sao_state_healthcare_confirmed_wgs84.geojson"
    confirmed = json.loads(confirmed_path.read_text(encoding="utf-8"))
    new_confirmed = [
        point("Родильный дом ГКБ им. В.В. Вересаева", "Москва, ул. Лобненская, д. 10, стр. 10", 37.5327811, 55.8898254,
              facility_type="Родильный дом", ownership="ГБУЗ города Москвы", verification_status="Подтверждено официальным сайтом учреждения",
              official_source="https://gkb81.ru/directions/rody/", official_evidence="Родильный дом работает по адресу: Лобненская улица, 10с10."),
        point("Филиал № 2 НМИЦ ВМТ им. А.А. Вишневского Минобороны России", "Москва, ул. Левобережная, д. 11", 37.4632313, 55.8797354,
              facility_type="Военный клинический госпиталь", ownership="Федеральное государственное учреждение Минобороны России", verification_status="Подтверждено официальным сайтом учреждения",
              official_source="https://www.2filial.ru/contacts/", official_evidence="Официальный адрес филиала: Левобережная улица, д. 11."),
        point("Институт Вельтищева", "Москва, ул. Талдомская, д. 2", 37.5206136, 55.8718919,
              facility_type="Научно-исследовательский клинический институт", ownership="Федеральное государственное учреждение Минздрава России", verification_status="Подтверждено официальным сайтом учреждения",
              official_source="https://telemed.pedklin.ru/pedklin/patient/about", official_evidence="Почтовый адрес: Москва, ул. Талдомская, д. 2."),
        point("НМИЦ травматологии и ортопедии им. Н.Н. Приорова", "Москва, ул. Приорова, д. 10", 37.5306800, 55.8201292,
              facility_type="Национальный медицинский исследовательский центр", ownership="Федеральное государственное учреждение Минздрава России", verification_status="Подтверждено официальным сайтом учреждения",
              official_source="https://www.cito-priorov.ru/contacts/", official_evidence="Официальный адрес: Москва, ул. Приорова, д. 10."),
        point("Городская клиническая больница № 24", "Москва, ул. Писцовая, д. 10", 37.5789474, 55.7984216,
              facility_type="Городская клиническая больница", ownership="ГБУЗ города Москвы", verification_status="Подтверждено официальным сайтом учреждения",
              official_source="https://gkb-24.ru/about-hospital/faq", official_evidence="Стационар ГБУЗ «ГКБ №24»: ул. Писцовая, д. 10."),
    ]
    new_confirmed.extend([
        point("\u0413\u0411\u0423\u0417 \xab\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u043f\u043e\u043b\u0438\u043a\u043b\u0438\u043d\u0438\u043a\u0430 \u2116 6 \u0414\u0417\u041c\xbb, \u0444\u0438\u043b\u0438\u0430\u043b \u21161", "\u041c\u043e\u0441\u043a\u0432\u0430, 1-\u044f \u041a\u0432\u0435\u0441\u0438\u0441\u0441\u043a\u0430\u044f \u0443\u043b\u0438\u0446\u0430, 8", 37.5815778, 55.7941049,
              facility_type="\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u043f\u043e\u043b\u0438\u043a\u043b\u0438\u043d\u0438\u043a\u0430", ownership="\u0413\u0411\u0423\u0417 \u0433\u043e\u0440\u043e\u0434\u0430 \u041c\u043e\u0441\u043a\u0432\u044b", verification_status="\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u043e \u043e\u0444\u0438\u0446\u0438\u0430\u043b\u044c\u043d\u044b\u043c \u0441\u0430\u0439\u0442\u043e\u043c \u0443\u0447\u0440\u0435\u0436\u0434\u0435\u043d\u0438\u044f", official_source="https://gp6.moscow/contacts/", official_evidence="\u0424\u0438\u043b\u0438\u0430\u043b \u21161: 1-\u044f \u041a\u0432\u0435\u0441\u0438\u0441\u0441\u043a\u0430\u044f \u0443\u043b., \u0434. 8."),
        point("\u0413\u0411\u0423\u0417 \xab\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u043f\u043e\u043b\u0438\u043a\u043b\u0438\u043d\u0438\u043a\u0430 \u2116 6 \u0414\u0417\u041c\xbb, \u0444\u0438\u043b\u0438\u0430\u043b \u21162", "\u041c\u043e\u0441\u043a\u0432\u0430, 3-\u0439 \u041c\u0438\u0445\u0430\u043b\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u043f\u0435\u0440\u0435\u0443\u043b\u043e\u043a, 22", 37.5250676, 55.8366056,
              facility_type="\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u043f\u043e\u043b\u0438\u043a\u043b\u0438\u043d\u0438\u043a\u0430", ownership="\u0413\u0411\u0423\u0417 \u0433\u043e\u0440\u043e\u0434\u0430 \u041c\u043e\u0441\u043a\u0432\u044b", verification_status="\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u043e \u043e\u0444\u0438\u0446\u0438\u0430\u043b\u044c\u043d\u044b\u043c \u0441\u0430\u0439\u0442\u043e\u043c \u0443\u0447\u0440\u0435\u0436\u0434\u0435\u043d\u0438\u044f", official_source="https://gp6.moscow/contacts/", official_evidence="\u0424\u0438\u043b\u0438\u0430\u043b \u21162: 3-\u0439 \u041c\u0438\u0445\u0430\u043b\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u043f\u0435\u0440\u0435\u0443\u043b\u043e\u043a, \u0434. 22."),
        point("\u0413\u0411\u0423\u0417 \xab\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u043f\u043e\u043b\u0438\u043a\u043b\u0438\u043d\u0438\u043a\u0430 \u2116 6 \u0414\u0417\u041c\xbb, \u0444\u0438\u043b\u0438\u0430\u043b \u21163", "\u041c\u043e\u0441\u043a\u0432\u0430, 3-\u0439 \u041d\u043e\u0432\u043e\u043c\u0438\u0445\u0430\u043b\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u043f\u0440\u043e\u0435\u0437\u0434, 3\u0410, \u0441\u0442\u0440\u043e\u0435\u043d\u0438\u0435 1", 37.5428429, 55.8394815,
              facility_type="\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u043f\u043e\u043b\u0438\u043a\u043b\u0438\u043d\u0438\u043a\u0430", ownership="\u0413\u0411\u0423\u0417 \u0433\u043e\u0440\u043e\u0434\u0430 \u041c\u043e\u0441\u043a\u0432\u044b", verification_status="\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u043e \u043e\u0444\u0438\u0446\u0438\u0430\u043b\u044c\u043d\u044b\u043c \u0441\u0430\u0439\u0442\u043e\u043c \u0443\u0447\u0440\u0435\u0436\u0434\u0435\u043d\u0438\u044f", official_source="https://gp6.moscow/contacts/", official_evidence="\u0424\u0438\u043b\u0438\u0430\u043b \u21163: 3-\u0439 \u041d\u043e\u0432\u043e\u043c\u0438\u0445\u0430\u043b\u043a\u043e\u0432\u0441\u043a\u0438\u0439 \u043f\u0440\u043e\u0435\u0437\u0434, \u0434. 3\u0410, \u0441\u0442\u0440. 1."),
        point("\u0413\u0411\u0423\u0417 \xab\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u043f\u043e\u043b\u0438\u043a\u043b\u0438\u043d\u0438\u043a\u0430 \u2116 6 \u0414\u0417\u041c\xbb, \u0444\u0438\u043b\u0438\u0430\u043b \u21164", "\u041c\u043e\u0441\u043a\u0432\u0430, \u0443\u043b\u0438\u0446\u0430 \u041d\u0435\u043c\u0447\u0438\u043d\u043e\u0432\u0430, 14", 37.5646994, 55.8232559,
              facility_type="\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u043f\u043e\u043b\u0438\u043a\u043b\u0438\u043d\u0438\u043a\u0430", ownership="\u0413\u0411\u0423\u0417 \u0433\u043e\u0440\u043e\u0434\u0430 \u041c\u043e\u0441\u043a\u0432\u044b", verification_status="\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u043e \u043e\u0444\u0438\u0446\u0438\u0430\u043b\u044c\u043d\u044b\u043c \u0441\u0430\u0439\u0442\u043e\u043c \u0443\u0447\u0440\u0435\u0436\u0434\u0435\u043d\u0438\u044f", official_source="https://gp6.moscow/contacts/", official_evidence="\u0424\u0438\u043b\u0438\u0430\u043b \u21164: \u0443\u043b. \u041d\u0435\u043c\u0447\u0438\u043d\u043e\u0432\u0430, \u0434. 14."),
        point("\u0413\u0411\u0423\u0417 \xab\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u043f\u043e\u043b\u0438\u043a\u043b\u0438\u043d\u0438\u043a\u0430 \u2116 6 \u0414\u0417\u041c\xbb, \u0444\u0438\u043b\u0438\u0430\u043b \u21165", "\u041c\u043e\u0441\u043a\u0432\u0430, \u0443\u043b\u0438\u0446\u0430 \u042e\u043d\u043d\u0430\u0442\u043e\u0432, 12", 37.5608069, 55.8009753,
              facility_type="\u0413\u043e\u0440\u043e\u0434\u0441\u043a\u0430\u044f \u043f\u043e\u043b\u0438\u043a\u043b\u0438\u043d\u0438\u043a\u0430", ownership="\u0413\u0411\u0423\u0417 \u0433\u043e\u0440\u043e\u0434\u0430 \u041c\u043e\u0441\u043a\u0432\u044b", verification_status="\u041f\u043e\u0434\u0442\u0432\u0435\u0440\u0436\u0434\u0435\u043d\u043e \u043e\u0444\u0438\u0446\u0438\u0430\u043b\u044c\u043d\u044b\u043c \u0441\u0430\u0439\u0442\u043e\u043c \u0443\u0447\u0440\u0435\u0436\u0434\u0435\u043d\u0438\u044f", official_source="https://gp6.moscow/contacts/", official_evidence="\u0424\u0438\u043b\u0438\u0430\u043b \u21165: \u0443\u043b. \u042e\u043d\u043d\u0430\u0442\u043e\u0432, \u0434. 12."),
    ])
    existing = {(item["properties"].get("name"), item["properties"].get("address")) for item in confirmed["features"]}
    confirmed["features"].extend(item for item in new_confirmed if (item["properties"].get("name"), item["properties"].get("address")) not in existing)
    confirmed_path.write_text(json.dumps(confirmed, ensure_ascii=False, indent=2), encoding="utf-8")

    review = [point("Подстанция скорой помощи № 18", "Москва, ул. Новая Ипатовка, д. 3Б", 37.5368282, 55.8171891,
                    facility_type="Подстанция скорой и неотложной медицинской помощи", ownership="ГБУЗ города Москвы",
                    verification_status="Учреждение государственное; адрес ожидает служебного подтверждения",
                    official_source="https://mos03.ru/", official_evidence="Официальный сайт ССиНМП им. А.С. Пучкова подтверждает организацию, но не публикует адрес этой подстанции.")]
    (args.output_dir / "sao_state_healthcare_candidates_wgs84.geojson").write_text(
        json.dumps(feature_collection(review), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
