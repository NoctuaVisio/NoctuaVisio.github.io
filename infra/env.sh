# Shared settings for the infra scripts. Override by exporting before sourcing.
#   source infra/env.sh
export PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project 2>/dev/null)}"
# us-central1, not São Paulo: gs://noctua-models already lives there, so this
# puts compute next to the data and avoids the ~30% South America premium.
# The heavy download (the 3D model) comes straight from that bucket either way.
export REGION="${REGION:-us-central1}"
export AR_REPO="${AR_REPO:-noctua}"                    # Artifact Registry repository
export SA_NAME="${SA_NAME:-noctua-api}"                # runtime service account
export SERVICE="${SERVICE:-noctua-api-staging}"        # Cloud Run service
# Environment name, baked into every resource created from here on. Bucket
# names are a GLOBAL namespace in GCS and cannot be renamed, so staging and prod
# get separate ones from the start.
export ENV_NAME="${ENV_NAME:-staging}"
export GCS_BUCKET="${GCS_BUCKET:-noctua-models}"                      # existing public bucket
export GCS_PRIVATE_BUCKET="${GCS_PRIVATE_BUCKET:-noctua-private-${ENV_NAME}}"
export BUILD_SA_NAME="${BUILD_SA_NAME:-noctua-build}"   # Cloud Build identity
export SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
export BUILD_SA_EMAIL="${BUILD_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
export IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE}"
