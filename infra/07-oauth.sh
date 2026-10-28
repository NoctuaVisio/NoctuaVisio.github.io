#!/usr/bin/env bash
# Turn social login providers on for the Cloud Run service.
#
# A provider is enabled purely by the presence of its credentials, so this
# script is the whole switch — there is no code path to change. Client ids are
# public by design and go in as plain env vars; secrets are mounted from Secret
# Manager so they never appear in the service config or in shell history.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh

GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-}"
GOOGLE_SECRET_NAME="${GOOGLE_SECRET_NAME:-google-oauth-secret}"
GITHUB_CLIENT_ID="${GITHUB_CLIENT_ID:-}"
GITHUB_SECRET_NAME="${GITHUB_SECRET_NAME:-github-oauth-secret}"

ENV_VARS=()
SECRETS=()

if [ -n "$GOOGLE_CLIENT_ID" ]; then
  gcloud secrets describe "$GOOGLE_SECRET_NAME" --project "$PROJECT_ID" >/dev/null
  ENV_VARS+=("GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}")
  SECRETS+=("GOOGLE_CLIENT_SECRET=${GOOGLE_SECRET_NAME}:latest")
  echo "    google: on"
fi
if [ -n "$GITHUB_CLIENT_ID" ]; then
  gcloud secrets describe "$GITHUB_SECRET_NAME" --project "$PROJECT_ID" >/dev/null
  ENV_VARS+=("GITHUB_CLIENT_ID=${GITHUB_CLIENT_ID}")
  SECRETS+=("GITHUB_CLIENT_SECRET=${GITHUB_SECRET_NAME}:latest")
  echo "    github: on"
fi

[ ${#ENV_VARS[@]} -gt 0 ] || { echo "nothing to do — set GOOGLE_CLIENT_ID and/or GITHUB_CLIENT_ID"; exit 1; }

# --update-*, never --set-*: replacing would drop the database wiring.
gcloud run services update "$SERVICE" \
  --project "$PROJECT_ID" --region "$REGION" \
  --update-env-vars "$(IFS=,; echo "${ENV_VARS[*]}")" \
  --update-secrets "$(IFS=,; echo "${SECRETS[*]}")"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)')"
echo
echo "check: curl -s $URL/auth/providers"
