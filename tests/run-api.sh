#!/usr/bin/env bash
# The API tests, against a real Postgres. Separate from tests/run.sh because
# those need nothing but node, and this needs a database.
#
# Local database, once:
#   brew install postgresql@16
#   /opt/homebrew/opt/postgresql@16/bin/pg_ctl \
#     -D /opt/homebrew/var/postgresql@16 -o "-p 55432" -l /tmp/pg55432.log start
#   psql -p 55432 -d postgres -c "create role noctua login password 'noctua' superuser"
#   psql -p 55432 -d postgres -c "create database noctua owner noctua"
#   psql -p 55432 -d noctua   -c "create extension if not exists pgcrypto"
#   (cd api && ../.venv/bin/alembic upgrade head)
#
# That port and those credentials are what api/db.py falls back to, so nothing
# needs to be exported. To point somewhere else, set DATABASE_URL. Every test
# runs inside a transaction that is rolled back, so staging is a safe target.
set -euo pipefail
cd "$(dirname "$0")/.."
PY="${PY:-.venv/bin/python}"
"$PY" tests/api_http.py
exec "$PY" tests/api_access.py
