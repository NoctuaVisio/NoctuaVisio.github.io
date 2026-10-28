"""Noctua API — slice 0.

Serves the existing static site plus a health endpoint, so the current site can
run unchanged on Cloud Run before any data moves to Postgres. Everything under
/api/ is reserved for the backend and never falls through to the static files.
"""
import os
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy import text

from api.db import engine

# In the container the site is copied to /app/site (without api/ and infra/).
# Locally it defaults to the repo root, one level above this file.
SITE_ROOT = Path(os.environ.get("SITE_ROOT", Path(__file__).resolve().parent.parent))
REVISION = os.environ.get("K_REVISION", "local")

app = FastAPI(title="noctua-api", docs_url=None, redoc_url=None)


# The migration this image expects. Read once at import. A mismatch against the
# database means code shipped without its migration, which surfaces as a 500 on
# whatever route touches the new column — invisible until someone reads the
# logs. Reporting it in health makes it checkable, and the deploy script fails
# the deploy on it.
def _expected_schema() -> Optional[str]:
    try:
        from alembic.config import Config
        from alembic.script import ScriptDirectory

        cfg = Config(str(Path(__file__).resolve().parent / "alembic.ini"))
        heads = ScriptDirectory.from_config(cfg).get_heads()
        return heads[0] if len(heads) == 1 else ",".join(sorted(heads))
    except Exception:
        return None


EXPECTED_SCHEMA = _expected_schema()


# Health lives under /api/ on purpose: Google's frontend swallows a bare
# /healthz before it ever reaches the container (empty `server` header, nothing
# in the Cloud Run request log), so that path is unusable here.
#
# `ok` means "the database answers", not "the process is up", because the
# frontend uses this endpoint to decide whether to read from the API or from the
# committed JSON files. A database outage therefore degrades the site to the
# files shipped inside this image instead of breaking every read.
#
# That safety net lasts only while the image still carries those files. When the
# cutover removes them (slice 4), this has to become a hard failure instead.
@app.get("/api/health")
def health():
    db_ok = True
    detail = None
    schema = None
    try:
        with engine.connect() as conn:
            conn.execute(text("select 1"))
            schema = conn.execute(text("select version_num from alembic_version")).scalar()
    except Exception as exc:
        db_ok = False
        detail = type(exc).__name__
    return {
        "ok": db_ok,
        "revision": REVISION,
        "db": db_ok,
        "error": detail,
        "schema": schema,
        "schema_expected": EXPECTED_SCHEMA,
        "schema_ok": schema is not None and schema == EXPECTED_SCHEMA,
    }


@app.get("/api/version")
def version():
    return {"service": "noctua-api", "revision": REVISION, "slice": 0}


from api.routes import auth as auth_routes  # noqa: E402
from api.routes import hub as hub_routes  # noqa: E402
from api.routes import legacy  # noqa: E402
from api.routes import share as share_routes  # noqa: E402
from api.routes import access as access_routes  # noqa: E402
from api.routes import pages as page_routes  # noqa: E402
from api.routes import uploads as upload_routes  # noqa: E402
from api.routes import write as write_routes  # noqa: E402

app.include_router(legacy.router)
app.include_router(hub_routes.router)
# Before the static mount, so the rendered page wins over the committed file
# that is still sitting in the image.
app.include_router(page_routes.router)
app.include_router(write_routes.router)
app.include_router(access_routes.router)
app.include_router(upload_routes.router)
app.include_router(share_routes.router)
app.include_router(auth_routes.router)


# Reserved prefixes. Declared before the static mount so backend paths can never
# serve source files, even when SITE_ROOT is the repo root during local dev.
@app.api_route("/api/{path:path}", methods=["GET", "POST", "PATCH", "DELETE"])
def api_not_found(path: str):
    return JSONResponse({"error": "not_found", "path": f"/api/{path}"}, status_code=404)


@app.api_route("/infra/{path:path}", methods=["GET"])
def infra_not_found(path: str):
    return JSONResponse({"error": "not_found"}, status_code=404)


@app.api_route("/auth/{path:path}", methods=["GET", "POST"])
def auth_not_found(path: str):
    return JSONResponse({"error": "not_found", "path": f"/auth/{path}"}, status_code=404)


# GitHub Pages serves 404.html for unknown paths, which is how /inspection/<slug>
# routes today. Keep that behaviour byte-for-byte until SSR replaces it.
@app.exception_handler(404)
async def spa_fallback(request: Request, exc):
    if request.url.path.startswith(("/api/", "/infra/", "/auth/")):
        return JSONResponse({"error": "not_found"}, status_code=404)
    page = SITE_ROOT / "404.html"
    if page.is_file():
        return FileResponse(
            page, status_code=404, media_type="text/html",
            headers={"Cache-Control": NO_CACHE},
        )
    return JSONResponse({"error": "not_found"}, status_code=404)


# "Store it, but ask me before using it." The browser keeps the file and gets a
# cheap 304 while it is unchanged, and never serves a stale copy.
#
# StaticFiles sends no Cache-Control at all, and a response with neither that
# nor Expires is cached *heuristically*: browsers invent a freshness lifetime
# from how old Last-Modified is. The site has no build step, so filenames carry
# no content hash and every deploy rewrites the same paths. A browser was
# therefore free to pair freshly deployed HTML with a JavaScript file it had
# been holding for hours — which is exactly how the unified hub shipped and
# then failed with "NoctuaHub.fetchHub is not a function": the page called a
# function that existed in the deployed hub-core.js and not in the cached one.
#
# Blobs in GCS are untouched by this: they are content-addressed and uploaded
# with `max-age=31536000, immutable`, which is correct for a name that can
# never mean different bytes.
NO_CACHE = "no-cache"


class RevalidatingStatic(StaticFiles):
    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers.setdefault("Cache-Control", NO_CACHE)
        return response


app.mount("/", RevalidatingStatic(directory=SITE_ROOT, html=True), name="site")
