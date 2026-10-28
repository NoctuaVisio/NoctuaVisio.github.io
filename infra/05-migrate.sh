#!/usr/bin/env bash
# Run Alembic (and optionally the importer) against Cloud SQL from this machine,
# tunnelled through the Cloud SQL Auth Proxy. The proxy authenticates with your
# gcloud identity, so the instance needs no authorised networks.
#
#   ./infra/05-migrate.sh            # migrations only
#   ./infra/05-migrate.sh --import   # migrations, then import the repo's JSON
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh

INSTANCE="${INSTANCE:-noctua-pg}"
DB_NAME="${DB_NAME:-noctua}"
DB_USER="${DB_USER:-noctua}"
SECRET="${SECRET:-noctua-db-password}"
PROXY_PORT="${PROXY_PORT:-55433}"

command -v cloud-sql-proxy >/dev/null || { echo "cloud-sql-proxy not found (brew install cloud-sql-proxy)"; exit 1; }

CONN="$(gcloud sql instances describe "$INSTANCE" --project "$PROJECT_ID" --format='value(connectionName)')"
PASSWORD="$(gcloud secrets versions access latest --secret "$SECRET" --project "$PROJECT_ID")"

# The proxy wants Application Default Credentials, which need a browser flow.
# Handing it the gcloud access token instead reuses the login that is already
# there — enough for a migration, since the token outlives one by an hour.
PROXY_AUTH=()
if [ ! -f "$HOME/.config/gcloud/application_default_credentials.json" ]; then
  PROXY_AUTH=(--token "$(gcloud auth print-access-token)")
fi

echo "==> proxy on 127.0.0.1:${PROXY_PORT} -> ${CONN}"
cloud-sql-proxy "${PROXY_AUTH[@]}" --port "$PROXY_PORT" "$CONN" &
PROXY_PID=$!
trap 'kill $PROXY_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  (exec 3<>"/dev/tcp/127.0.0.1/${PROXY_PORT}") 2>/dev/null && break
  sleep 1
done

export DATABASE_URL="postgresql+psycopg://${DB_USER}:${PASSWORD}@127.0.0.1:${PROXY_PORT}/${DB_NAME}"
PY=".venv/bin/python"
[ -x "$PY" ] || PY="python3"

echo "==> alembic upgrade head"
"${PY%python}alembic" -c api/alembic.ini upgrade head 2>/dev/null \
  || "$PY" -m alembic -c api/alembic.ini upgrade head

if [ "${1:-}" = "--import" ]; then
  echo "==> importing the repo's JSON"
  "$PY" -m api.scripts.import_json --root .
  echo "==> parity check"
  "$PY" -m api.scripts.check_parity --root .
fi
