"""Проверяет, отличается ли развёрнутый код от репозитория только переводами строк."""

import hashlib
import pathlib

DEPLOYED = {
    "auth.js": "217bd267804ad930df6c2f45d2bfe2e3",
    "completion.js": "01527b89121973746cf8aab653a6c159",
    "config.js": "3421a5539a06157046622d297c328956",
    "exports.js": "d98f93f42010d2589721a291d950a935",
    "geo.js": "b9fa66aa0dd24da57da5a47912b98bfd",
    "health.js": "df6b0e480be2b087dbfe910e3a1022c3",
    "labels.js": "1d68b7cbccda06df92bc195bab6cc668",
    "login-throttle.js": "a54a0f5880b014ad653ee8c796bade52",
    "multipart.js": "df211039404e71df3a2bf92789bf8062",
    "pdf-charts.js": "375df9b4acfd175a67cdf27ca7730dc1",
    "report.js": "611e249ecf6903b529ddb64919232586",
    "reports.js": "05ac143fcb5322f3c13d72e2b7eaa66e",
    "storage.js": "ca90e42653992f5507a4bc14c16d35a1",
}

identical = 0
for name, deployed in DEPLOYED.items():
    raw = (pathlib.Path("photo-service/src") / name).read_bytes()
    as_crlf = raw.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
    if hashlib.md5(as_crlf).hexdigest() == deployed:
        identical += 1
        print(f"  {name:<18} совпадает (только переводы строк)")
    else:
        print(f"  {name:<18} РАСХОДИТСЯ по содержимому")

print(f"\nсовпало {identical} из {len(DEPLOYED)}")
