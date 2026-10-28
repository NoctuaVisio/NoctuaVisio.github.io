"""Signed URLs for the models bucket.

Why signing happens here and not in the browser: the admin currently mints a
Google token with `devstorage.read_write` scope inside the page, which means the
tab holds a credential that can write anything in the bucket, and anyone who can
run script in that tab inherits it. A signed URL is scoped to one object, one
method and one deadline.

Cloud Run's service account has no private key file, so signatures are produced
through the IAM credentials API (signBlob). That needs
`roles/iam.serviceAccountTokenCreator` on the service account itself.
"""
from __future__ import annotations

import datetime as dt
import os
from typing import Optional

import google.auth
from google.auth.transport import requests as ga_requests
from google.cloud import storage

# Two buckets, and nothing ever moves between them: every image and model row
# records which bucket it is in, so existing objects keep the URL they were
# delivered with. New blobs are routed by what they are, not by where there is
# room.
#
#   PUBLIC  — thumbnails and OG images, which exist to be fetched by crawlers
#             that cannot authenticate, plus models of public assets (the
#             landing carousel), where signing would cost cache and protect
#             nothing.
#   PRIVATE — everything else: models of delivered inspections, defect crops,
#             ortho tiles. Reads are signed.
PUBLIC_BUCKET = os.environ.get("GCS_BUCKET", "noctua-models")
# No default. A guessed name here could be a bucket that does not exist, or
# worse, one that is public — and the failure would be silent. Unset means
# private uploads are refused, never quietly stored in the open.
PRIVATE_BUCKET = os.environ.get("GCS_PRIVATE_BUCKET") or None

# Kept for callers that predate the split.
BUCKET = PUBLIC_BUCKET
UPLOAD_TTL = dt.timedelta(minutes=15)
# Read URLs are rounded to a window boundary so the same object yields the same
# URL for everyone inside that window. Without the rounding every page load
# would produce a new URL and a 55MB model would be re-downloaded each time
# instead of served from the browser cache.
READ_TTL = dt.timedelta(days=7)
READ_WINDOW = dt.timedelta(hours=12)

_client: Optional[storage.Client] = None
_signer_email: Optional[str] = None


def _ensure() -> tuple[storage.Client, str]:
    global _client, _signer_email
    if _client is None:
        credentials, project = google.auth.default()
        # Needed so the credentials carry a token signBlob can be called with.
        credentials.refresh(ga_requests.Request())
        _client = storage.Client(project=project, credentials=credentials)
        _signer_email = getattr(credentials, "service_account_email", None) or os.environ.get(
            "SIGNER_SERVICE_ACCOUNT", ""
        )
    return _client, _signer_email or ""


def is_private(bucket: Optional[str]) -> bool:
    return bool(PRIVATE_BUCKET) and bucket == PRIVATE_BUCKET


def require_private_bucket() -> str:
    if not PRIVATE_BUCKET:
        raise RuntimeError(
            "GCS_PRIVATE_BUCKET is not set; refusing to store a private object "
            "in the public bucket"
        )
    return PRIVATE_BUCKET


def public_url(bucket: str, object_path: str) -> str:
    return f"https://storage.googleapis.com/{bucket}/{object_path}"


def url_for(bucket: Optional[str], object_path: str) -> str:
    """The URL to hand a browser for this object.

    One place decides, so no caller has to know which bucket is which. A NULL
    bucket is a site-local path (/models/x.glb) from before the GCS move.
    """
    if not bucket:
        return object_path
    if is_private(bucket):
        return signed_read_url(object_path, bucket)
    return public_url(bucket, object_path)


def delete_object(object_path: str, bucket: Optional[str] = None) -> None:
    """Remove a blob. Already absent counts as success — the caller wants it
    gone, and raising would make the row survive a blob that is not there."""
    from google.api_core import exceptions as gexc

    client, _ = _ensure()
    blob = client.bucket(bucket or PUBLIC_BUCKET).blob(object_path)
    try:
        blob.delete()
    except gexc.NotFound:
        pass


def object_exists(object_path: str, bucket: Optional[str] = None) -> bool:
    client, _ = _ensure()
    return client.bucket(bucket or PUBLIC_BUCKET).blob(object_path).exists()


def signed_upload_url(object_path: str, content_type: str,
                      bucket: Optional[str] = None) -> str:
    client, signer = _ensure()
    blob = client.bucket(bucket or PUBLIC_BUCKET).blob(object_path)
    return blob.generate_signed_url(
        version="v4",
        expiration=UPLOAD_TTL,
        method="PUT",
        content_type=content_type,
        service_account_email=signer or None,
        access_token=_access_token(),
    )


def signed_read_url(object_path: str, bucket: Optional[str] = None) -> str:
    client, signer = _ensure()
    blob = client.bucket(bucket or require_private_bucket()).blob(object_path)
    return blob.generate_signed_url(
        version="v4",
        expiration=_window_expiry(),
        method="GET",
        service_account_email=signer or None,
        access_token=_access_token(),
    )


def _window_expiry() -> dt.datetime:
    """A deadline snapped to the next READ_WINDOW boundary, plus READ_TTL.

    Deterministic within the window, so the signature — and therefore the URL —
    is identical for every caller until the boundary moves.
    """
    now = dt.datetime.now(dt.timezone.utc)
    step = int(READ_WINDOW.total_seconds())
    epoch = int(now.timestamp())
    boundary = ((epoch // step) + 1) * step
    return dt.datetime.fromtimestamp(boundary, dt.timezone.utc) + READ_TTL


def _access_token() -> Optional[str]:
    credentials, _ = google.auth.default()
    if not credentials.valid:
        credentials.refresh(ga_requests.Request())
    return getattr(credentials, "token", None)
