"""Изолированный локальный стенд оператора САО.

Статические JS/CSS-ресурсы взяты из публичной сборки сайта, а API намеренно
заменён локальным mock-сервисом. Сервер не делает исходящих запросов к САО.
"""

from __future__ import annotations

import argparse
import json
import os
import threading
import uuid
from datetime import datetime, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
API_PREFIX = "/api/v1"
SESSION_NAME = "operator_test_sid"
DEMO_LOGIN = "demo@local.test"
DEMO_PASSWORD = "demo"

AREAS = [
    {"id": "019c6be6-b28b-77db-9333-bc66389fbec4", "name": "Бескудниковский"},
    {"id": "019c6be6-b300-775f-ba14-132272635a99", "name": "Беговой"},
    {"id": "019c6be6-b2e6-7324-911e-cc1b20cf4a58", "name": "Головинский"},
    {"id": "019c6be6-b3b4-715c-9d57-dc263b4bc761", "name": "Тимирязевский"},
    {"id": "019c6be6-b2d1-7217-87b6-a421e3a3c4ad", "name": "Ховрино"},
]


def _stats(index: int) -> dict[str, object]:
    total = 96 + index * 19
    accepted = total - (8 + index * 3)
    problem = 18 + index * 11
    ratio = round(accepted / total * 100)
    return {
        "total_tasks": total,
        "accepted_tasks": accepted,
        "edc_reports": 7 + index * 2,
        "edc_reports_previous": 6 + index,
        "nash_gorod_reports": 4 + index,
        "nash_gorod_reports_previous": 5 + index,
        "accepted_ratio_color": "green" if ratio >= 71 else "yellow",
        "assignment_problem_pct": problem,
        "assignment_color": "green" if problem <= 40 else "yellow",
    }


AREA_STATS = {area["id"]: _stats(index) for index, area in enumerate(AREAS)}
ASSIGNMENT_STATS = {
    area_id: {
        "assignment_problem_pct": stats["assignment_problem_pct"],
        "assignment_color": stats["assignment_color"],
    }
    for area_id, stats in AREA_STATS.items()
}

USER = {
    "id": "019c-test-operator-0000-000000000001",
    "login": DEMO_LOGIN,
    "email": DEMO_LOGIN,
    "first_name": "Демо",
    "last_name": "Оператор",
    "full_name": "Демо Оператор",
    "language": "ru",
    "roles": ["Префектура"],
    "project_roles": [],
    "should_change_password": False,
}


class MockState:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.sessions: set[str] = set()
        self.requests: list[dict[str, object]] = []

    def remember(self, method: str, path: str, status: int) -> None:
        with self.lock:
            self.requests.append(
                {
                    "at": datetime.now(timezone.utc).isoformat(),
                    "method": method,
                    "path": path,
                    "status": status,
                }
            )
            del self.requests[:-200]


STATE = MockState()


def _json_bytes(payload: object) -> bytes:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _read_json(handler: BaseHTTPRequestHandler) -> dict[str, object]:
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except ValueError:
        length = 0
    if length <= 0:
        return {}
    try:
        value = json.loads(handler.rfile.read(length).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


class Handler(BaseHTTPRequestHandler):
    server_version = "SAOOperatorTest/1.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[mock] {self.address_string()} {fmt % args}")

    @property
    def session_id(self) -> str | None:
        cookies = SimpleCookie(self.headers.get("Cookie", ""))
        morsel = cookies.get(SESSION_NAME)
        return morsel.value if morsel else None

    def is_authenticated(self) -> bool:
        sid = self.session_id
        return bool(sid and sid in STATE.sessions)

    def send_bytes(self, body: bytes, content_type: str, status: int = 200, extra: dict[str, str] | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, payload: object, status: int = 200, extra: dict[str, str] | None = None) -> None:
        self.send_bytes(_json_bytes(payload), "application/json; charset=utf-8", status, extra)

    def redirect(self, location: str) -> None:
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith(API_PREFIX + "/"):
            self.handle_api("GET", path[len(API_PREFIX) :], parse_qs(parsed.query))
            return
        if path == "/__mock__/health":
            self.send_json({"ok": True, "service": "local-mock-api", "authenticated": self.is_authenticated()})
            return
        if path == "/__mock__/requests":
            self.send_json(STATE.requests)
            return
        if path == "/":
            self.redirect("/operator" if self.is_authenticated() else "/login?next=%2Foperator")
            return
        if path == "/operator":
            if not self.is_authenticated():
                self.redirect("/login?next=%2Foperator")
                return
            self.serve_file("operator.html", "text/html; charset=utf-8")
            return
        if path == "/login":
            self.serve_file("login.html", "text/html; charset=utf-8")
            return
        if path.startswith("/_next/") or path.startswith("/brand/") or path == "/favicon.ico":
            self.serve_file(path.lstrip("/"), None)
            return
        self.send_json({"detail": "Not found"}, 404)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path.startswith(API_PREFIX + "/"):
            self.handle_api("POST", path[len(API_PREFIX) :], {})
            return
        self.send_json({"detail": "Not found"}, 404)

    def do_PATCH(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path.startswith(API_PREFIX + "/"):
            self.handle_api("PATCH", path[len(API_PREFIX) :], {})
            return
        self.send_json({"detail": "Not found"}, 404)

    def do_DELETE(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path.startswith(API_PREFIX + "/"):
            self.handle_api("DELETE", path[len(API_PREFIX) :], {})
            return
        self.send_json({"detail": "Not found"}, 404)

    def handle_api(self, method: str, path: str, query: dict[str, list[str]]) -> None:
        payload = _read_json(self) if method in {"POST", "PATCH"} else {}
        status = 200
        extra: dict[str, str] = {}

        if path == "/auth/login" and method == "POST":
            if payload.get("login") != DEMO_LOGIN or payload.get("password") != DEMO_PASSWORD:
                status = 401
                result: object = {"message": "Для локального стенда используйте demo@local.test / demo"}
            else:
                sid = uuid.uuid4().hex
                with STATE.lock:
                    STATE.sessions.add(sid)
                extra["Set-Cookie"] = f"{SESSION_NAME}={sid}; Path=/; SameSite=Lax"
                result = {"user": USER}
        elif path == "/auth/logout" and method == "DELETE":
            if self.session_id:
                with STATE.lock:
                    STATE.sessions.discard(self.session_id)
            extra["Set-Cookie"] = f"{SESSION_NAME}=; Max-Age=0; Path=/; SameSite=Lax"
            result = {"ok": True}
        elif path == "/auth/refresh" and method == "POST":
            result = {"ok": self.is_authenticated()}
            if not self.is_authenticated():
                status = 401
        elif path == "/users/me" and method == "GET":
            result = USER if self.is_authenticated() else {"detail": "Not authenticated"}
            if not self.is_authenticated():
                status = 401
        elif path == "/users/me" and method == "PATCH":
            result = USER if self.is_authenticated() else {"detail": "Not authenticated"}
            if not self.is_authenticated():
                status = 401
        elif path == "/balance/areas" and method == "GET":
            result = AREAS
        elif path == "/balance/territories/stats" and method == "GET":
            result = AREA_STATS
        elif path == "/balance/territories/assignment-map-stats" and method == "GET":
            result = ASSIGNMENT_STATS
        elif path.startswith("/balance/areas/") and path.endswith("/workshops"):
            result = []
        elif path.startswith("/balance/areas/") and path.endswith("/territory-summary"):
            result = {"title": "Территории района", "description": "Данные локального стенда", "total": AREA_STATS.get(path.split("/")[3], {})}
        elif path.startswith("/balance/areas/") and path.endswith("/territory-coverage"):
            result = {"items": []}
        elif path.startswith("/operator/") or path.startswith("/balance/"):
            result = self.generic_result(path)
        else:
            status = 404
            result = {"detail": "Mock endpoint is not implemented", "path": path}

        STATE.remember(method, path, status)
        self.send_json(result, status, extra)

    @staticmethod
    def generic_result(path: str) -> object:
        if path.endswith("/users/") or path.endswith("/tasks/") or path.endswith("/territories"):
            return {"count": 0, "next": None, "previous": None, "items": []}
        if path.endswith("/areas") or path.endswith("/workshops") or path.endswith("/violation-types/"):
            return []
        return {}

    def serve_file(self, relative: str, content_type: str | None) -> None:
        relative_path = Path(relative.replace("/", "/"))
        if any(part in {"", ".", ".."} for part in relative_path.parts):
            self.send_json({"detail": "Not found"}, 404)
            return
        target = (ROOT / relative_path).resolve()
        if ROOT not in target.parents or not target.is_file():
            self.send_json({"detail": "Not found"}, 404)
            return
        if content_type is None:
            content_type = {
                ".js": "text/javascript; charset=utf-8",
                ".css": "text/css; charset=utf-8",
                ".ico": "image/x-icon",
                ".svg": "image/svg+xml",
            }.get(target.suffix.lower(), "application/octet-stream")
        self.send_bytes(target.read_bytes(), content_type)


def main() -> None:
    parser = argparse.ArgumentParser(description="Локальный стенд оператора САО")
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8765")))
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Локальный стенд: http://{args.host}:{args.port}/operator")
    print(f"Демо-вход: {DEMO_LOGIN} / {DEMO_PASSWORD}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nОстановка стенда")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
