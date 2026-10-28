#!/usr/bin/env bash
# Cloud SQL for PostgreSQL: instance, database, app user, password in Secret Manager.
# 💸 This is the first resource that bills while idle. Smallest zonal tier, no HA.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh

INSTANCE="${INSTANCE:-noctua-pg}"
DB_NAME="${DB_NAME:-noctua}"
DB_USER="${DB_USER:-noctua}"
SECRET="${SECRET:-noctua-db-password}"

# --edition=ENTERPRISE is required, not cosmetic: POSTGRES_16 now defaults to
# ENTERPRISE_PLUS, which rejects shared-core tiers like db-f1-micro and only
# takes db-perf-optimized-*, several times the price.
echo "==> instance '$INSTANCE' (${REGION}, zonal, ENTERPRISE, db-f1-micro)"
if ! gcloud sql instances describe "$INSTANCE" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud sql instances create "$INSTANCE" \
    --project "$PROJECT_ID" --region "$REGION" \
    --database-version=POSTGRES_16 \
    --edition=ENTERPRISE \
    --tier=db-f1-micro \
    --storage-type=SSD --storage-size=10GB --storage-auto-increase \
    --availability-type=zonal \
    --backup-start-time=05:00 \
    --maintenance-window-day=SUN --maintenance-window-hour=6
else
  echo "    já existe"
fi

echo "==> database '$DB_NAME'"
gcloud sql databases describe "$DB_NAME" --instance "$INSTANCE" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud sql databases create "$DB_NAME" --instance "$INSTANCE" --project "$PROJECT_ID"

echo "==> password in Secret Manager ('$SECRET')"
if ! gcloud secrets describe "$SECRET" --project "$PROJECT_ID" >/dev/null 2>&1; then
  PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  printf '%s' "$PASSWORD" | gcloud secrets create "$SECRET" --project "$PROJECT_ID" --data-file=-
else
  PASSWORD="$(gcloud secrets versions access latest --secret "$SECRET" --project "$PROJECT_ID")"
  echo "    já existe (reutilizando)"
fi
gcloud secrets add-iam-policy-binding "$SECRET" --project "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" --role="roles/secretmanager.secretAccessor" --quiet >/dev/null

echo "==> user '$DB_USER'"
if gcloud sql users list --instance "$INSTANCE" --project "$PROJECT_ID" --format='value(name)' | grep -qx "$DB_USER"; then
  gcloud sql users set-password "$DB_USER" --instance "$INSTANCE" --project "$PROJECT_ID" --password "$PASSWORD" --quiet
else
  gcloud sql users create "$DB_USER" --instance "$INSTANCE" --project "$PROJECT_ID" --password "$PASSWORD"
fi

CONN="$(gcloud sql instances describe "$INSTANCE" --project "$PROJECT_ID" --format='value(connectionName)')"
echo
echo "connection name: $CONN"
echo "DATABASE_URL (Cloud Run, unix socket):"
echo "  postgresql+psycopg://${DB_USER}:<secret>@/${DB_NAME}?host=/cloudsql/${CONN}"
echo
echo "para rodar alembic/import da sua máquina:"
echo "  cloud-sql-proxy --port 55433 $CONN &"
echo "  DATABASE_URL=postgresql+psycopg://${DB_USER}:\$(gcloud secrets versions access latest --secret $SECRET)@127.0.0.1:55433/${DB_NAME} \\"
echo "    .venv/bin/alembic -c api/alembic.ini upgrade head"
