"""Writing assets and inspections — the end of committing JSON to a repository.

The payload is the same shape the editor already holds and used to commit, so
the editor changes transport, not its data model. Parsing and normalisation come
from `api.ingest`, the same code the one-off importer runs, which is what keeps
"what a save produces" and "what an import produces" from drifting apart.

Authorisation splits on creation: making a NEW asset needs platform admin,
because there is no asset yet to hold a role on. Everything after that is
`editor` on the asset in question.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from api import ingest
from api.auth.deps import require_asset_role, require_user
from api.db import get_session
from api.models import (
    Annotation,
    Anomaly,
    Asset,
    AuditLog,
    EvalTask,
    Featured,
    Image,
    Inspection,
    Model3D,
    Photo,
    User,
)
from api.routes.legacy import asset_payload, inspection_payload

router = APIRouter(prefix="/api", tags=["write"])

SLUG_OK = __import__("re").compile(r"^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$")


def _check_slug(slug: str) -> str:
    if not SLUG_OK.match(slug):
        raise HTTPException(400, "slug must be lowercase letters, digits and hyphens")
    return slug


def _audit(db: DbSession, user: User, action: str, kind: str, subject: str,
           meta: Optional[dict] = None) -> None:
    db.add(
        AuditLog(user_id=user.id, action=action, subject_type=kind,
                 subject_id=subject, meta=meta or {})
    )


def reclaim_orphan_blobs(db: DbSession) -> dict:
    """Delete blobs nothing references any more, from the bucket and the tables.

    The admin used to work this out in the browser: fetch every asset and every
    inspection, union their object names, and subtract. That is O(n) requests
    and races any concurrent edit — a blob could be adopted by a save that
    landed between the listing and the delete. Here it is one query per table
    against the state the delete just produced.

    Content addressing is what makes this necessary at all: two assets can share
    the exact same bytes, so "this asset is gone" never means "its model is
    gone".
    """
    referenced_images = set()
    for col in (Asset.thumbnail_id, Inspection.thumbnail_id,
                Photo.image_id, Anomaly.crop_image_id):
        referenced_images.update(i for i in db.scalars(select(col)) if i)
    referenced_models = {m for m in db.scalars(select(Inspection.model_id)) if m}

    removed = {"images": 0, "models": 0, "bucket_errors": 0}
    for row in db.scalars(select(Image)).all():
        if row.id in referenced_images:
            continue
        if _drop_blob(row.bucket, row.object_path, removed):
            db.delete(row)
            removed["images"] += 1
    for row in db.scalars(select(Model3D)).all():
        if row.id in referenced_models:
            continue
        if _drop_blob(row.bucket, row.object_path, removed):
            db.delete(row)
            removed["models"] += 1
    db.flush()
    return removed


def _drop_blob(bucket: Optional[str], object_path: str, tally: dict) -> bool:
    """True when the row may go. A bucket error keeps the row, deliberately:
    a dangling row is recoverable, a row deleted while its object survives
    leaks storage nobody can find again."""
    if not bucket:
        return True          # site-local path, nothing in a bucket to remove
    try:
        from api import storage

        storage.delete_object(object_path, bucket)
        return True
    except Exception:
        tally["bucket_errors"] += 1
        return False


@router.put("/assets/{slug}")
def put_asset(
    slug: str,
    payload: dict[str, Any] = Body(...),
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    _check_slug(slug)
    existing = db.scalar(select(Asset).where(Asset.slug == slug))
    if existing is None:
        if user.role != "admin":
            raise HTTPException(403, "creating an asset requires platform admin")
    else:
        require_asset_role(db, user, existing, "editor")

    try:
        asset = ingest.upsert_asset(db, slug, payload, user)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    _audit(db, user, "asset.create" if existing is None else "asset.update",
           "asset", slug, {"name": asset.name})
    db.commit()
    return asset_payload(db, asset)


@router.put("/inspections/{slug}")
def put_inspection(
    slug: str,
    payload: dict[str, Any] = Body(...),
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    _check_slug(slug)
    asset_slug = payload.get("asset")
    asset = db.scalar(select(Asset).where(Asset.slug == asset_slug)) if asset_slug else None
    if asset is None:
        raise HTTPException(400, f"asset '{asset_slug}' does not exist")
    require_asset_role(db, user, asset, "editor")

    existing = db.scalar(select(Inspection).where(Inspection.slug == slug))
    warnings: list[str] = []
    try:
        insp = ingest.upsert_inspection(db, slug, payload, user, warnings=warnings)
    except ValueError as err:
        raise HTTPException(400, str(err)) from err
    _audit(db, user, "inspection.create" if existing is None else "inspection.update",
           "inspection", slug,
           {"points": len(payload.get("points") or []), "warnings": warnings})
    db.commit()
    out = inspection_payload(db, insp)
    # Surfaced rather than logged away: an unmatched defect means a polygon the
    # geometry could not tie to any point, and the operator is the only one who
    # can say which anomaly it belongs to.
    if warnings:
        out["_warnings"] = warnings
    return out


@router.delete("/inspections/{slug}")
def delete_inspection(
    slug: str,
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    insp = db.scalar(select(Inspection).where(Inspection.slug == slug))
    if insp is None:
        raise HTTPException(404, "inspection not found")
    require_asset_role(db, user, db.get(Asset, insp.asset_id), "editor")
    ingest.wipe_inspection_children(db, insp)
    row = db.get(Featured, insp.id)
    if row is not None:
        db.delete(row)
    db.delete(insp)
    db.flush()
    reclaimed = reclaim_orphan_blobs(db)
    _audit(db, user, "inspection.delete", "inspection", slug, {"reclaimed": reclaimed})
    db.commit()
    return {"ok": True, "deleted": slug, "reclaimed": reclaimed}


@router.put("/tasks/{legacy_id}")
def put_task(
    legacy_id: str,
    payload: dict[str, Any] = Body(...),
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    """Evaluation task state, keyed by the id the editor already uses.

    Everything the task carries beyond kind/status/align/source goes into
    `payload` untouched — cursor, applied counts, the photo list. That state
    gets a real model when the evaluation flow is rebuilt; losing it in the
    meantime would be worse than storing it opaquely.
    """
    insp_slug = payload.get("inspection")
    insp = db.scalar(select(Inspection).where(Inspection.slug == insp_slug)) if insp_slug else None
    if insp is None:
        raise HTTPException(400, f"inspection '{insp_slug}' does not exist")
    require_asset_role(db, user, db.get(Asset, insp.asset_id), "editor")

    t = db.scalar(select(EvalTask).where(EvalTask.legacy_id == legacy_id))
    if t is None:
        t = EvalTask(legacy_id=legacy_id)
        db.add(t)
    t.inspection_id = insp.id
    t.kind = ingest.ftext(payload.get("kind"))
    t.status = payload.get("status") if payload.get("status") in ("pending", "running", "done") else "pending"
    t.align = payload.get("align")
    t.source = payload.get("source")
    t.payload = {k: v for k, v in payload.items()
                 if k not in ("id", "kind", "status", "align", "source", "inspection")}
    if t.created_by is None:
        t.created_by = user.id
    _audit(db, user, "task.update", "task", legacy_id, {"status": t.status})
    db.commit()
    return {"ok": True, "id": legacy_id, "status": t.status}


@router.put("/featured/{slug}")
def add_featured(
    slug: str,
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    """Put an inspection on the landing carousel. Replaces landing-models.json.

    A private inspection can be featured and simply will not render: the
    carousel endpoint filters by visibility, because being featured is an
    editorial choice and must not override who may see something.
    """
    insp = db.scalar(select(Inspection).where(Inspection.slug == slug))
    if insp is None:
        raise HTTPException(404, "inspection not found")
    require_asset_role(db, user, db.get(Asset, insp.asset_id), "editor")
    if db.get(Featured, insp.id) is None:
        last = db.scalar(select(Featured.position).order_by(Featured.position.desc()).limit(1))
        db.add(Featured(inspection_id=insp.id, position=(last or 0) + 1))
        _audit(db, user, "featured.add", "inspection", slug)
        db.commit()
    return {"ok": True, "featured": slug, "visible": insp.visibility == "public"}


@router.delete("/featured/{slug}")
def remove_featured(
    slug: str,
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    insp = db.scalar(select(Inspection).where(Inspection.slug == slug))
    if insp is None:
        raise HTTPException(404, "inspection not found")
    require_asset_role(db, user, db.get(Asset, insp.asset_id), "editor")
    row = db.get(Featured, insp.id)
    if row is not None:
        db.delete(row)
        _audit(db, user, "featured.remove", "inspection", slug)
        db.commit()
    return {"ok": True, "removed": slug}


@router.delete("/assets/{slug}")
def delete_asset(
    slug: str,
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    """Delete an asset and its inspections.

    The blobs are deliberately left in the bucket. Objects are addressed by
    content hash and therefore shared: the model of this asset may be the exact
    same bytes as another's, and deleting it would break that one with no
    warning. Reclaiming unreferenced objects is a sweep over the tables, not a
    side effect of a delete.
    """
    asset = db.scalar(select(Asset).where(Asset.slug == slug))
    if asset is None:
        raise HTTPException(404, "asset not found")
    require_asset_role(db, user, asset, "editor")

    inspections = db.scalars(select(Inspection).where(Inspection.asset_id == asset.id)).all()
    for insp in inspections:
        ingest.wipe_inspection_children(db, insp)
        row = db.get(Featured, insp.id)
        if row is not None:
            db.delete(row)
        db.delete(insp)
    db.flush()
    db.delete(asset)
    reclaimed = reclaim_orphan_blobs(db)
    _audit(db, user, "asset.delete", "asset", slug,
           {"inspections": [i.slug for i in inspections], "reclaimed": reclaimed})
    db.commit()
    return {"ok": True, "deleted": slug,
            "inspections": [i.slug for i in inspections],
            "reclaimed": reclaimed}
