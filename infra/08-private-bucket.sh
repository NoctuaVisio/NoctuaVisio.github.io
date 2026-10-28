#!/usr/bin/env bash
# The private bucket: models of delivered inspections, defect crops, ortho tiles.
# Read only through signed URLs; nothing in here is world-readable.
#
# Separate from the public bucket rather than mixed with per-object ACLs, so a
# mistake cannot make a client's model public — the bucket itself refuses.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh

BUCKET="${GCS_PRIVATE_BUCKET}"
# Same region as the compute and the public bucket: keeps reads off the
# inter-region path and out of inter-region egress.
LOCATION="${REGION}"

echo "==> bucket gs://${BUCKET} (${LOCATION})"
if gcloud storage buckets describe "gs://${BUCKET}" --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "    já existe"
else
  gcloud storage buckets create "gs://${BUCKET}" \
    --project "$PROJECT_ID" \
    --location "$LOCATION" \
    --default-storage-class=STANDARD \
    --uniform-bucket-level-access \
    --public-access-prevention
fi

# Re-asserted on every run: these are the two settings whose silent absence
# would make the bucket readable, and a bucket created by hand often lacks them.
echo "==> hardening"
gcloud storage buckets update "gs://${BUCKET}" \
  --uniform-bucket-level-access --public-access-prevention >/dev/null
echo "    uniform bucket-level access + public access prevention"

# Versioning: a client deliverable overwritten by mistake is otherwise gone, and
# these objects are addressed by content hash so overwrites should never be
# routine anyway. Cheap insurance on a bucket this small.
gcloud storage buckets update "gs://${BUCKET}" --versioning >/dev/null
echo "    object versioning"

echo "==> IAM"
# The API signs and writes; the build service account writes when it fetches a
# model server-side on our behalf.
for SA in "$SA_EMAIL" "$BUILD_SA_EMAIL"; do
  gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
    --member="serviceAccount:${SA}" --role="roles/storage.objectAdmin" --quiet >/dev/null
  echo "    objectAdmin: ${SA}"
done

# Signing through the IAM credentials API needs the service account to be able
# to sign as itself — Cloud Run has no private key file to sign with.
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project "$PROJECT_ID" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/iam.serviceAccountTokenCreator" --quiet >/dev/null
echo "    serviceAccountTokenCreator: ${SA_EMAIL} on itself (for signBlob)"

echo
echo "wire it up:  gcloud run services update ${SERVICE} --region ${REGION} \\"
echo "               --update-env-vars GCS_PRIVATE_BUCKET=${BUCKET}"
