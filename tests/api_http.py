"""HTTP contract checks that need no database.

Each one stands for a failure that reached a browser:

* **Static files without Cache-Control.** A response carrying neither that nor
  Expires is cached *heuristically*: the browser invents a lifetime from how old
  Last-Modified is. This site has no build step, so no filename carries a
  content hash and every deploy rewrites the same paths. A browser was free to
  pair newly deployed HTML with JavaScript it had held for hours, which is how
  the unified hub shipped and then failed with "NoctuaHub.fetchHub is not a
  function" — the page called something that existed in the deployed
  hub-core.js and not in the cached one.

* **Reserved prefixes falling through to the static mount.** `/api/…` must never
  serve a source file, even when SITE_ROOT is the repo root in development.

* **The legacy hub paths.** Three pages became one; the old URLs are in
  bookmarks and in links already handed to clients.

    .venv/bin/python tests/api_http.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient    # noqa: E402

from api.main import app                     # noqa: E402

checks = 0
failures: list[str] = []


def check(label: str, got, want):
    global checks
    checks += 1
    if got != want:
        failures.append(f"{label}: got {got!r}, wanted {want!r}")


def main() -> int:
    client = TestClient(app)

    # ── every file the browser executes must be revalidated ─────────────────
    for path in ("/hub-core.js", "/card.js", "/noctua-data.js", "/noctua-auth.js",
                 "/assets/index.html", "/admin-hub.css", "/legal.css"):
        r = client.get(path)
        check(f"{path} is served", r.status_code, 200)
        cc = r.headers.get("cache-control", "")
        check(f"{path} must be revalidated, not heuristically cached",
              "no-cache" in cc or "no-store" in cc, True)

    # ── reserved prefixes never reach the static mount ──────────────────────
    for path in ("/api/nope", "/infra/env.sh", "/auth/nope"):
        r = client.get(path)
        check(f"{path} is refused", r.status_code, 404)
        check(f"{path} answers as the API, not as a file",
              r.headers.get("content-type", "").startswith("application/json"), True)

    # ── one hub: the old paths still resolve, and point at it ───────────────
    for path in ("/admin/", "/inspections/", "/admin/list/", "/admin/inspections/"):
        r = client.get(path)
        check(f"{path} is served", r.status_code, 200)
        check(f"{path} sends the browser to /assets/", "'/assets/'" in r.text, True)

    r = client.get("/assets/")
    check("the hub reads the hub endpoint", "NoctuaHub.fetchHub()" in r.text, True)
    check("the hub no longer filters by isOpen", ".isOpen)" in r.text, False)

    for f in failures:
        print(f"  ✗ {f}")
    print(f"{'FAILED' if failures else 'ok'}: {checks - len(failures)}/{checks} checks")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
