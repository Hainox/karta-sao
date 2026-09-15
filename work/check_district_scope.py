"""Проверяет на проде, что районная учётка ограничена своим районом.

Логинится районной учёткой и смотрит: что отдаёт сводка, закрыты ли выгрузки,
не видно ли чужих объектов. Пароль не печатается.
"""

import sys
import urllib.error
import urllib.request
from http.cookiejar import CookieJar

sys.path.insert(0, "work")
from check_production_uploads import read_accounts, request  # noqa: E402

API = "https://obhod-sao.ru/photo-api"
ACCOUNTS = r"C:\Users\dmitr\Desktop\Учётки фотослужбы САО.xlsx"

_, accounts = read_accounts(ACCOUNTS)
districts = [a for a in accounts if "район" in a["role"].lower()]
print("районных учёток:", len(districts))

failures = []


def check(name, condition, detail=""):
    print("%s %s%s" % ("ok  " if condition else "FAIL", name, f" :: {detail}" if detail else ""))
    if not condition:
        failures.append(name)


for account in districts:
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    status, body = request(opener, f"{API}/auth/login", "POST",
                           {"login": account["login"], "password": account["password"]})
    if status != 200:
        check(f"{account['district']}: вход", False, str(body)[:120])
        continue

    status, summary = request(opener, f"{API}/reports/summary")
    if status != 200:
        check(f"{account['district']}: сводка", False, str(summary)[:120])
        continue

    visible = [row["district"] for row in summary.get("byDistrict", [])]
    check(f"{account['district']}: видит только свой район",
          visible == [account["district"]],
          f"видно: {visible}")

    objects = summary.get("objects", [])
    foreign = sorted({obj.get("district") for obj in objects if obj.get("district") not in (account["district"], None)})
    check(f"{account['district']}: в объектах нет чужих районов", not foreign, f"чужие: {foreign[:5]}")

    for kind in ("xlsx", "pdf"):
        status, _ = request(opener, f"{API}/reports/export.{kind}")
        check(f"{account['district']}: выгрузка {kind} закрыта", status == 403, f"ответ {status}")

    status, _ = request(opener, f"{API}/photos?datasetId=entrances&sourceId=1")
    check(f"{account['district']}: фото чужого объекта не отдаются", status in (403, 404), f"ответ {status}")

    print(f"     объектов с фото: {sum(obj.get('photoCount', 0) or 0 for obj in objects)}")

print()
print("провалов:", len(failures))
for name in failures:
    print("  -", name)
