#!/usr/bin/env bash
# CORS on the models bucket.
#
# The browser fetches .glb / .splat / images cross-origin from whatever origin
# the site is served on, so every origin that serves the site has to be listed
# here or the model silently fails to load (the object is public; it is the
# preflight that blocks). Declarative: this file is the whole config.
set -euo pipefail
cd "$(dirname "$0")/.."
source infra/env.sh

# Both buckets. A signed URL still goes through a browser preflight, so the
# private bucket needs the same origin list or every upload fails with a CORS
# error that says nothing about signing.
BUCKETS="${GCS_BUCKET:-noctua-models} ${GCS_PRIVATE_BUCKET:-}"

# Cloud Run answers on TWO hostnames for the same service — the hashed one that
# `describe` reports, and <service>-<project number>.<region>.run.app. A browser
# can land on either, and only listing one means the model loads on one URL and
# is blocked on the other. Build both.
PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
RUN_URLS="$(printf '%s\n%s\n' \
  "$(gcloud run services describe "$SERVICE" --project "$PROJECT_ID" --region "$REGION" --format='value(status.url)' 2>/dev/null)" \
  "https://${SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app" | sed '/^$/d' | sort -u)"

ORIGINS=$(python3 - "$RUN_URLS" <<'PY'
import json, sys
fixed = [
    "https://noctuavisio.com",
    "https://www.noctuavisio.com",
    "http://localhost:8080",
    "http://localhost:8089",
    "http://127.0.0.1:8080",
    "http://127.0.0.1:8099",
]
run = [u.strip() for u in sys.argv[1].splitlines() if u.strip()]
seen, out = set(), []
for o in fixed + run:
    if o not in seen:
        seen.add(o); out.append(o)
print(json.dumps(out))
PY
)

CONFIG=$(mktemp /tmp/cors-XXXX.json)
python3 - "$ORIGINS" > "$CONFIG" <<'PY'
import json, sys
print(json.dumps([{
    "origin": json.loads(sys.argv[1]),
    "method": ["GET", "HEAD", "PUT", "POST", "OPTIONS"],
    "responseHeader": [
        "Content-Type", "Authorization", "X-Goog-Resumable", "Content-Range",
        "X-Upload-Content-Type", "X-Upload-Content-Length", "Location",
    ],
    "maxAgeSeconds": 3600,
}], indent=2))
PY

echo "==> origins:"
python3 -c "import json,sys;[print('   ',o) for o in json.load(open(sys.argv[1]))[0]['origin']]" "$CONFIG"
for B in $BUCKETS; do
  [ -n "$B" ] || continue
  if gcloud storage buckets describe "gs://${B}" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud storage buckets update "gs://${B}" --cors-file="$CONFIG"
    echo "    applied to gs://${B}"
  else
    echo "    skipped gs://${B} (does not exist yet)"
  fi
done
rm -f "$CONFIG"
echo "done (preflights are cached for maxAgeSeconds, so a stale browser may need a reload)"
