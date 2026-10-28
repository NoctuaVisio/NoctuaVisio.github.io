#!/usr/bin/env bash
# Attach the Cloud SQL instance to the Cloud Run service.
#
# The password is mounted from Secret Manager as an env var and the connection
# URL is assembled inside the app (api/db.py), so the credential never appears
# in a deploy command, shell history or Cloud Run's config listing.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh

INSTANCE="${INSTANCE:-noctua-pg}"
DB_NAME="${DB_NAME:-noctua}"
DB_USER="${DB_USER:-noctua}"
SECRET="${SECRET:-noctua-db-password}"

CONN="$(gcloud sql instances describe "$INSTANCE" --project "$PROJECT_ID" \
  --format='value(connectionName)')"
echo "==> attaching $CONN to $SERVICE"

gcloud run services update "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" \
  --add-cloudsql-instances "$CONN" \
  --update-env-vars "INSTANCE_CONNECTION_NAME=${CONN},DB_USER=${DB_USER},DB_NAME=${DB_NAME}" \
  --update-secrets "DB_PASSWORD=${SECRET}:latest"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --format='value(status.url)')"
echo
echo "check: curl -s $URL/api/health    # ok:true means the database answered"
