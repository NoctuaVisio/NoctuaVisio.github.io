#!/usr/bin/env bash
# Point noctuavisio.com at Cloud Run instead of GitHub Pages.
#
# 💸 Domain mapping itself is free; the traffic is the Cloud Run cost you
# already pay. What it costs is reversibility: every client link in the wild
# starts resolving here the moment DNS propagates.
#
#   ./infra/09-domain.sh check     what still has to happen (changes nothing)
#   ./infra/09-domain.sh map       create the mapping and print the DNS records
#
# The DNS records themselves have to be changed at the registrar — this script
# cannot do that part, and prints exactly what to set.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh

DOMAIN="${DOMAIN:-noctuavisio.com}"
ACTION="${1:-check}"

echo "==> readiness for ${DOMAIN} -> ${SERVICE} (${REGION})"

URL="$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" \
  --format='value(status.url)' 2>/dev/null || true)"
[ -n "$URL" ] || { echo "!! service ${SERVICE} not found in ${REGION}"; exit 1; }

HEALTH="$(curl -s --max-time 60 "$URL/api/health" || true)"
echo "    health: $HEALTH"
case "$HEALTH" in
  *'"schema_ok":true'*) ;;
  *) echo "!! the service is not healthy or its schema is behind — fix before cutover"; exit 1 ;;
esac

# Every hostname the browser will be on has to be registered with the OAuth
# client and allowed by bucket CORS, or sign-in and model loading break for
# real clients at the worst possible moment.
# Checked, not recited. CORS is observable from here; the OAuth client is not —
# Google answers the authorize endpoint the same way whether a redirect URI is
# registered or not, so the only honest statement is that it cannot be verified
# without DNS already pointing here.
echo "==> bucket CORS for https://${DOMAIN}"
MODEL_URL="https://storage.googleapis.com/${GCS_BUCKET}/$(gcloud storage ls "gs://${GCS_BUCKET}" --project "$PROJECT_ID" 2>/dev/null | grep -m1 '\.glb$' | sed "s|gs://${GCS_BUCKET}/||")"
if curl -s -o /dev/null -D- --max-time 60 -r 0-99 -H "Origin: https://${DOMAIN}" "$MODEL_URL" 2>/dev/null | grep -qi 'access-control-allow-origin'; then
  echo "    allowed"
else
  echo "!! NOT allowed — run ./infra/06-bucket-cors.sh before cutover"
fi
echo "==> cannot be checked from here:"
echo "    OAuth redirect URI https://${DOMAIN}/auth/google/callback"
echo "    OAuth JavaScript origin https://${DOMAIN}"
echo "    (if missing, sign-in fails with redirect_uri_mismatch after cutover)"

if [ "$ACTION" != "map" ]; then
  echo
  echo "nothing changed. run './infra/09-domain.sh map' when the list above is done."
  exit 0
fi

echo "==> domain mapping"
gcloud beta run domain-mappings describe --domain "$DOMAIN" \
  --project "$PROJECT_ID" --region "$REGION" >/dev/null 2>&1 \
  || gcloud beta run domain-mappings create \
       --service "$SERVICE" --domain "$DOMAIN" \
       --project "$PROJECT_ID" --region "$REGION"

echo
echo "==> set these at the registrar, replacing the GitHub Pages records:"
# flatten(): without it the table prints one row of collapsed lists instead of
# one row per record.
gcloud beta run domain-mappings describe --domain "$DOMAIN" \
  --project "$PROJECT_ID" --region "$REGION" \
  --flatten='status.resourceRecords[]' \
  --format='table(status.resourceRecords.type:label=TYPE, status.resourceRecords.rrdata:label=VALUE)'
echo
echo "the certificate is issued only after DNS resolves here, so expect a few"
echo "minutes of TLS errors between the DNS change and the first good request."
