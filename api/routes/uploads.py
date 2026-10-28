"""Uploads: the browser asks for a signed URL, PUTs the bytes, then commits.

Three steps instead of one because of dedupe. The site already names every blob
after its sha256, so the hash is known before the upload starts — which means
`sign` can answer "already there, skip it" and a 55MB model that exists is not
uploaded twice. That behaviour exists today in the admin; this keeps it while
moving the credential out of the browser.

The bytes never pass through this service. A 55MB model through a 512MiB
container would cost CPU and egress for no gain.
"""
from __future__ import annotations

import re
from typing import Literal, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from api import storage
from api.auth.deps import require_user
from api.db import get_session
from api.models import Image, Inspection, Model3D, User

router = APIRouter(prefix="/api/uploads", tags=["uploads"])

SHA256 = re.compile(r"^[0-9a-f]{64}$")

# Only what the viewer and the editor actually load. An open-ended list here
# would let an admin session park arbitrary content in a public bucket.
IMAGE_TYPES = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/tiff": ".tif",
}
MODEL_TYPES = {
    "model/gltf-binary": ".glb",
    "application/octet-stream": None,   # extension decided by `filename`
}
MODEL_EXTS = {".glb", ".splat", ".ply", ".ksplat", ".sog"}
MAX_BYTES = 2 * 1024 * 1024 * 1024      # 2 GiB


class _Blob(BaseModel):
    sha256: str = Field(min_length=64, max_length=64)
    kind: Literal["image", "model"]
    content_type: str
    bytes: int = Field(gt=0, le=MAX_BYTES)
    filename: Optional[str] = None
    # Which bucket this belongs in. Defaults to private, so forgetting the flag
    # over-protects instead of publishing a client's model — the failure that
    # costs nothing versus the one that cannot be undone.
    #
    # Pass true only for what must be readable without credentials: OG images
    # and thumbnails (crawlers cannot authenticate) and models of public assets,
    # where signing would break the browser cache and protect nothing.
    public: bool = False


class SignRequest(_Blob):
    # Instead of the caller reasoning about buckets, it can name the inspection
    # the blob is for and let the visibility ladder decide. `public` stays as the
    # explicit override for a thumbnail or OG image, which must stay readable
    # whatever the inspection's visibility is.
    for_inspection: Optional[str] = None


class CommitRequest(_Blob):
    for_inspection: Optional[str] = None
    width: Optional[int] = None
    height: Optional[int] = None
    model_kind: Optional[Literal["glb", "splat"]] = None


def _bucket_for(req: _Blob, db: Optional[DbSession] = None) -> str:
    """Which bucket, decided by the visibility ladder when it can be.

    `public=true` wins: it marks a blob that must be readable without
    credentials. Otherwise, if the caller said which inspection this is for, a
    `public` inspection puts the blob in the public bucket (signing it would
    cost cache and protect nothing) and `link`/`private` put it in the private
    one. With nothing to go on, private — over-protecting is the cheap mistake.
    """
    if req.public:
        return storage.PUBLIC_BUCKET
    slug = getattr(req, "for_inspection", None)
    if slug and db is not None:
        insp = db.scalar(select(Inspection).where(Inspection.slug == slug))
        if insp is not None and insp.visibility == "public":
            return storage.PUBLIC_BUCKET
    try:
        return storage.require_private_bucket()
    except RuntimeError as err:
        raise HTTPException(503, str(err)) from err


def _object_path(req: _Blob) -> str:
    if not SHA256.match(req.sha256):
        raise HTTPException(400, "sha256 must be 64 lowercase hex characters")
    if req.kind == "image":
        ext = IMAGE_TYPES.get(req.content_type)
        if not ext:
            raise HTTPException(400, f"unsupported image type '{req.content_type}'")
        return f"img/{req.sha256}{ext}"
    ext = (
        "." + req.filename.rsplit(".", 1)[-1].lower()
        if req.filename and "." in req.filename
        else MODEL_TYPES.get(req.content_type)
    )
    if ext not in MODEL_EXTS:
        raise HTTPException(400, f"unsupported model extension '{ext}'")
    return f"{req.sha256}{ext}"


@router.post("/sign")
def sign(
    req: SignRequest,
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    """A URL to PUT the bytes to — or `exists: true`, meaning don't bother."""
    path = _object_path(req)
    bucket = _bucket_for(req, db)
    known = (
        db.scalar(select(Image).where(Image.sha256 == req.sha256))
        if req.kind == "image"
        else db.scalar(select(Model3D).where(Model3D.sha256 == req.sha256))
    )
    if known is not None:
        # Already recorded, possibly in the other bucket — that is fine and
        # deliberate: the bytes are identical, and moving them would break the
        # URL already handed to someone.
        return {
            "exists": True,
            "bucket": known.bucket,
            "object_path": known.object_path,
            "upload_url": None,
        }
    if storage.object_exists(path, bucket):
        # In the bucket but not in the database: a previous upload that never
        # committed. Skip the transfer, let `commit` create the row.
        return {"exists": True, "bucket": bucket, "object_path": path, "upload_url": None}
    return {
        "exists": False,
        "bucket": bucket,
        "object_path": path,
        "upload_url": storage.signed_upload_url(path, req.content_type, bucket),
        "method": "PUT",
        "headers": {"Content-Type": req.content_type},
        "expires_in": int(storage.UPLOAD_TTL.total_seconds()),
    }


@router.post("/commit")
def commit(
    req: CommitRequest,
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    """Record the blob. Verifies it is actually in the bucket first.

    Without that check a caller could register rows for objects that do not
    exist, and the failure would only surface later as a broken viewer.
    """
    path = _object_path(req)
    bucket = _bucket_for(req, db)
    if req.kind == "image":
        row = db.scalar(select(Image).where(Image.sha256 == req.sha256))
        if row is None:
            if not storage.object_exists(path, bucket):
                raise HTTPException(409, "object is not in the bucket yet")
            row = Image(
                sha256=req.sha256,
                bucket=bucket,
                object_path=path,
                mime=req.content_type,
                width=req.width,
                height=req.height,
                bytes=req.bytes,
            )
            db.add(row)
            db.commit()
        return {"id": str(row.id), "bucket": row.bucket,
                "object_path": row.object_path, "sha256": row.sha256}

    row = db.scalar(select(Model3D).where(Model3D.sha256 == req.sha256))
    if row is None:
        if not storage.object_exists(path, bucket):
            raise HTTPException(409, "object is not in the bucket yet")
        kind = req.model_kind or (
            "splat" if path.rsplit(".", 1)[-1] in ("splat", "ply", "ksplat", "sog") else "glb"
        )
        row = Model3D(
            sha256=req.sha256,
            bucket=bucket,
            object_path=path,
            kind=kind,
            bytes=req.bytes,
            created_by=user.id,
        )
        db.add(row)
        db.commit()
    return {"id": str(row.id), "bucket": row.bucket,
            "object_path": row.object_path, "kind": row.kind}
