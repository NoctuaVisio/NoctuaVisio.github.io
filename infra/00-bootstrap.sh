#!/usr/bin/env bash
# One-time project setup: APIs, Artifact Registry, runtime service account.
# Idempotent — safe to re-run. Creates nothing that costs money on its own.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh

[ -n "$PROJECT_ID" ] || { echo "PROJECT_ID is empty. Run: gcloud config set project <id>"; exit 1; }
echo "project=$PROJECT_ID region=$REGION"

echo "==> enabling APIs (takes a minute the first time)"
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com \
  storage.googleapis.com \
  --project "$PROJECT_ID"

echo "==> Artifact Registry repository '$AR_REPO'"
gcloud artifacts repositories describe "$AR_REPO" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud artifacts repositories create "$AR_REPO" \
       --repository-format=docker --location "$REGION" \
       --description="Noctua container images" --project "$PROJECT_ID"

echo "==> service account '$SA_EMAIL'"
gcloud iam service-accounts describe "$SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$SA_NAME" \
       --display-name="Noctua API runtime" --project "$PROJECT_ID"

echo "==> roles for the runtime service account"
for ROLE in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" --role="$ROLE" \
    --condition=None --quiet >/dev/null
  echo "    $ROLE"
done

# Bucket-scoped, not project-wide: the API only needs objects in this bucket.
if gcloud storage buckets describe "gs://${GCS_BUCKET}" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET}" \
    --member="serviceAccount:${SA_EMAIL}" --role="roles/storage.objectAdmin" --quiet >/dev/null
  echo "    roles/storage.objectAdmin on gs://${GCS_BUCKET}"
else
  echo "    (bucket gs://${GCS_BUCKET} not visible from this project — skipped)"
fi

# Projects created after 2024 no longer grant the legacy Cloud Build roles to the
# Compute default service account, so builds need an identity of their own.
echo "==> build service account '$BUILD_SA_EMAIL'"
gcloud iam service-accounts describe "$BUILD_SA_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1 \
  || gcloud iam service-accounts create "$BUILD_SA_NAME" \
       --display-name="Noctua Cloud Build" --project "$PROJECT_ID"

for ROLE in roles/logging.logWriter roles/artifactregistry.writer; do
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${BUILD_SA_EMAIL}" --role="$ROLE" \
    --condition=None --quiet >/dev/null
  echo "    $ROLE"
done

# Writing blobs the build fetches on our behalf (models pulled server-side so a
# slow uplink never has to carry them).
if gcloud storage buckets describe "gs://${GCS_BUCKET}" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets add-iam-policy-binding "gs://${GCS_BUCKET}" \
    --member="serviceAccount:${BUILD_SA_EMAIL}" --role="roles/storage.objectAdmin" --quiet >/dev/null
  echo "    roles/storage.objectAdmin on gs://${GCS_BUCKET}"
fi

# Reading the uploaded source tarball. Scoped to the Cloud Build staging bucket,
# which is created on the first `gcloud builds submit`.
SRC_BUCKET="gs://${PROJECT_ID}_cloudbuild"
if gcloud storage buckets describe "$SRC_BUCKET" --project "$PROJECT_ID" >/dev/null 2>&1; then
  gcloud storage buckets add-iam-policy-binding "$SRC_BUCKET" \
    --member="serviceAccount:${BUILD_SA_EMAIL}" --role="roles/storage.objectViewer" --quiet >/dev/null
  echo "    roles/storage.objectViewer on ${SRC_BUCKET}"
else
  echo "    (${SRC_BUCKET} does not exist yet — re-run this script after the first build attempt)"
fi

echo
echo "done. next: ./infra/01-deploy.sh"
