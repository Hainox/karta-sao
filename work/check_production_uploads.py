"""Смотрит на проде, начали ли районы грузить фото.

Логинится учёткой префектуры из файла учёток и читает сводку photo-api.
Пароль нигде не печатается.
"""

import argparse
import json
import urllib.error
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

import openpyxl


def parse_args():
    parser = argparse.ArgumentParser(description="Проверка загрузок фото на проде")
    parser.add_argument("--accounts", required=True, help="файл с учётками")
    parser.add_argument("--api", default="https://obhod-sao.ru/photo-api")
    parser.add_argument("--role", default="prefecture", help="какую учётку взять")
    return parser.parse_args()


def read_accounts(path):
    book = openpyxl.load_workbook(path, read_only=True)
    page = book[book.sheetnames[0]]
    rows = list(page.iter_rows(values_only=True))
    header = [str(value).strip().lower() if value is not None else "" for value in rows[0]]

    def column(*names):
        for name in names:
            for index, title in enumerate(header):
                if name == title:
                    return index
        for name in names:
            for index, title in enumerate(header):
                if name in title:
                    return index
        return None

    login_at = column("логин", "login")
    password_at = column("пароль", "password")
    role_at = column("роль", "role", "уровень")
    district_at = column("район", "district")
    access_at = column("доступ", "access")
    accounts = []
    for row in rows[1:]:
        if not row or login_at is None or row[login_at] is None:
            continue
        accounts.append({
            "login": str(row[login_at]).strip(),
            "password": str(row[password_at]).strip() if password_at is not None and row[password_at] else "",
            "role": str(row[role_at]).strip() if role_at is not None and row[role_at] else "",
            "district": str(row[district_at]).strip() if district_at is not None and row[district_at] else "",
            "доступ": str(row[access_at]).strip() if access_at is not None and row[access_at] else "",
        })
    book.close()
    return header, accounts


def request(opener, url, method="GET", payload=None):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"Content-Type": "application/json"} if data else {}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with opener.open(req, timeout=60) as response:
            body = response.read().decode("utf-8")
            return response.status, (json.loads(body) if body.strip().startswith(("{", "[")) else body)
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8", "ignore")[:400]


def main():
    args = parse_args()
    header, accounts = read_accounts(Path(args.accounts))
    print("колонки в файле учёток:", header)
    for account in accounts:
        print("  %-20s логин %-22s роль %-14s доступ %s" % (
            account["district"], account["login"], account["role"], account.get("доступ", "")))
    district_accounts = [a for a in accounts if a["district"]]
    print("всего учёток:", len(accounts), "| из них районных:", len(district_accounts))

    prefecture = next((a for a in accounts if "префектур" in a["role"].lower() or "pref" in a["role"].lower()), None)
    if prefecture is None:
        prefecture = next((a for a in accounts if not a["district"]), None)
    if prefecture is None:
        print("не нашёл учётку префектуры — доступные роли:", sorted({a["role"] for a in accounts}))
        return
    print("логинюсь как:", prefecture["login"], "| роль:", prefecture["role"] or "(без роли)")

    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    status, body = request(opener, f"{args.api}/auth/login", "POST", {"login": prefecture["login"], "password": prefecture["password"]})
    print("вход:", status)
    if status != 200:
        print("ответ:", body)
        return
    print("кто вошёл:", {k: body.get(k) for k in ("login", "role", "district", "displayName") if k in body})

    status, summary = request(opener, f"{args.api}/reports/summary")
    print("\n=== сводка /reports/summary:", status, "===")
    if status == 200:
        print(json.dumps(summary, ensure_ascii=False, indent=2)[:4000])
    else:
        print(summary)


if __name__ == "__main__":
    main()
