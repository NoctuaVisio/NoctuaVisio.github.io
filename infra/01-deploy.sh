#!/usr/bin/env bash
# Build the image on Cloud Build and deploy it to Cloud Run.
# No local Docker needed — the source is uploaded and built in the cloud.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh

# The source tarball is ~21MB, almost all of it images/. On a slow or tunnelled
# link gcloud gives up mid-upload with a 408 long before the bytes are through,
# so give it room. The real fix is a Cloud Build trigger reading from GitHub,
# which uploads nothing from here at all.
export CLOUDSDK_CORE_HTTP_TIMEOUT="${CLOUDSDK_CORE_HTTP_TIMEOUT:-1800}"

TAG="$(git rev-parse --short HEAD 2>/dev/null || date +%s)"
echo "==> building ${IMAGE}:${TAG}"
gcloud builds submit --project "$PROJECT_ID" --region "$REGION" \
  --config infra/cloudbuild.yaml \
  --service-account "projects/${PROJECT_ID}/serviceAccounts/${BUILD_SA_EMAIL}" \
  --substitutions "_IMAGE=${IMAGE},_TAG=${TAG}" .

# --update-env-vars, never --set-env-vars: the latter REPLACES the whole
# environment, so a deploy would silently wipe the database wiring that
# 04-connect-db.sh put there and the container would fall back to localhost.
echo "==> deploying ${SERVICE}"
gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" \
  --image "${IMAGE}:${TAG}" \
  --service-account "$SA_EMAIL" \
  --allow-unauthenticated \
  --min-instances=0 --max-instances=4 \
  --cpu=1 --memory=512Mi --port=8080 \
  --update-env-vars="SITE_ROOT=/app/site,FORWARDED_ALLOW_IPS=*"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo
echo "live: $URL"

# Shipping code whose migration has not been applied fails as a 500 on the first
# route touching the new column, and stays silent until someone reads the logs.
# Turn it into a loud deploy failure instead.
HEALTH="$(curl -s --max-time 120 "$URL/api/health" || true)"
echo "health: $HEALTH"
case "$HEALTH" in
  *'"schema_ok":true'*)  echo "schema: in sync" ;;
  *'"schema_ok":false'*)
    echo
    echo "!! SCHEMA MISMATCH — the database is not at the migration this image expects."
    echo "!! Fix with: ./infra/05-migrate.sh"
    exit 1 ;;
  *) echo "schema: not verified (health unreachable)" ;;
esac
