"""Container healthcheck without third-party dependencies."""

import os
import sys
import urllib.request


host = os.environ.get("HEALTHCHECK_HOST", "127.0.0.1")
port = os.environ.get("PORT", "8765")
url = f"http://{host}:{port}/__mock__/health"

try:
    with urllib.request.urlopen(url, timeout=4) as response:
        body = response.read().decode("utf-8")
        if response.status != 200 or '"ok":true' not in body:
            raise RuntimeError(f"unexpected response: {response.status} {body[:200]}")
except Exception as exc:  # pragma: no cover - executed by Docker, not unit tests
    print(f"healthcheck failed: {exc}", file=sys.stderr)
    raise SystemExit(1) from exc
