"""Read-only endpoints that re-emit the exact shape of today's JSON files.

This is the parity bridge: the frontend can be pointed at /api/* without a
single change to how it reads data, and `api/scripts/check_parity.py` proves
the two sources agree before anything is switched over.

Values are rebuilt from the normalised columns on purpose — not from a stashed
copy of the original JSON. A field that cannot be reconstructed is information
the import lost, and the parity check is there to surface exactly that.
"""
from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal
from pathlib import PurePosixPath
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from api import storage
from api.auth.deps import asset_role, may_read, optional_user
from api.db import get_session
from api.models import User
from api.routes.share import token_from, valid_token
from api.models import (
    Annotation,
    Anomaly,
    AnomalyTag,
    Asset,
    EvalTask,
    Evaluation,
    Featured,
    Image,
    Inspection,
    Model3D,
    Photo,
)

router = APIRouter(prefix="/api", tags=["legacy"])


# ─────────────────────────── authorisation ─────────────────────────────

def _may_read_inspection(db: Session, user, request: Request, insp: Inspection) -> bool:
    """The three visibility tiers, and the one escape hatch.

    `link` requires *some* signed-in account, not a role. That is exactly what
    the old gate did — it demanded a Google sign-in and then accepted anybody —
    so keeping it is faithful rather than lax, and it is what makes the visitor
    log real: the viewer becomes a `users` row instead of a localStorage blob.

    A share token satisfies either tier without an account, which is the point
    of having it: delivering to someone who should not have to sign up.
    """
    if insp.visibility == "public":
        return True
    if valid_token(db, token_from(request), insp):
        return True
    if asset_role(db, user, db.get(Asset, insp.asset_id)) is not None:
        return True
    return insp.visibility == "link" and user is not None


def _forbid(user) -> HTTPException:
    return HTTPException(401 if user is None else 403, "not authorised")


# ───────────────────────────── formatting ──────────────────────────────

def url_of(bucket: Optional[str], object_path: str) -> str:
    """Delegates to storage, which signs private objects and leaves public ones
    alone. Doing it here would mean every payload builder had to know which
    bucket is which, and the one that forgot would emit a public URL for a
    private object — a 403 in the viewer with nothing to point at."""
    return storage.url_for(bucket, object_path)


def numstr(v: Any) -> Optional[str]:
    """Numbers come back as strings, the way the legacy files store them.

    Numeric columns return Decimal, which keeps the exact digits that went in,
    so '-8.5189' survives the round trip instead of becoming -8.518900000001.
    """
    if v is None:
        return None
    if isinstance(v, Decimal):
        v = v.normalize()
        return format(v, "f") if v == v.to_integral_value() else str(v)
    return str(v)


def iso_z(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    dt = dt.astimezone(timezone.utc)
    # Always three decimals: the legacy writer used Date#toISOString(), which
    # emits '.000Z' rather than dropping a zero millisecond field.
    return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}.{dt.microsecond // 1000:03d}Z"


def prune(d: dict) -> dict:
    """Drop keys whose value is None — the legacy files omit them entirely."""
    return {k: v for k, v in d.items() if v is not None}


# ─────────────────────────────── assets ────────────────────────────────

def model_fields(model: Optional[Model3D]) -> dict:
    """How a scan is spelled in a payload. One definition, two callers.

    The asset emits its latest inspection's scan; a resolved inspection emits
    its own. Writing it twice is how the two drifted — see `resolved_payload`.
    """
    if model is None:
        return {}
    murl = url_of(model.bucket, model.object_path)
    out: dict[str, Any] = {
        "model": murl,
        "modelName": PurePosixPath(murl).name,
        "modelRotation": model.rotation,
        "modelOffset": model.offset,
        "modelScale": float(model.scale) if model.scale is not None else None,
    }
    if model.kind == "splat":
        out["kind"] = "splat"
    return out


def asset_payload(s: Session, a: Asset) -> dict:
    model = s.scalar(
        select(Model3D)
        .join(Inspection, Inspection.model_id == Model3D.id)
        .where(Inspection.asset_id == a.id)
        .order_by(Inspection.captured_at.desc().nullslast())
        .limit(1)
    )
    thumb = s.get(Image, a.thumbnail_id) if a.thumbnail_id else None
    out: dict[str, Any] = {"slug": a.slug, "name": a.name}
    out.update(model_fields(model))
    # Always emitted. In the files the key is sometimes absent, and the frontend
    # reads that absence as `true` (`data.requireLogin !== false`); making it
    # explicit is the same meaning, stated.
    out["requireLogin"] = a.visibility != "public"
    out["thumbnail"] = url_of(thumb.bucket, thumb.object_path) if thumb else None
    out["createdAt"] = iso_z(a.created_at)
    return prune(out)


@router.get("/assets")
def list_assets(
    s: Session = Depends(get_session), user: Optional[User] = Depends(optional_user)
) -> list[str]:
    assets = s.scalars(select(Asset).order_by(Asset.slug)).all()
    return [a.slug for a in assets if may_read(s, user, a)]


@router.get("/assets/{slug}")
def get_asset(
    slug: str,
    s: Session = Depends(get_session),
    user: Optional[User] = Depends(optional_user),
) -> dict:
    a = s.scalar(select(Asset).where(Asset.slug == slug))
    if not a:
        raise HTTPException(404, "asset not found")
    if not may_read(s, user, a):
        raise _forbid(user)
    return asset_payload(s, a)


# ──────────────────────────── inspections ──────────────────────────────

def point_payload(s: Session, a: Anomaly) -> dict:
    ev = s.get(Evaluation, a.current_evaluation_id) if a.current_evaluation_id else None
    crop = s.get(Image, a.crop_image_id) if a.crop_image_id else None
    tags = list(
        s.scalars(
            select(AnomalyTag.tag)
            .where(AnomalyTag.anomaly_id == a.id)
            .order_by(AnomalyTag.position, AnomalyTag.tag)
        )
    )
    source = prune({
        "kind": a.source_kind,
        "name": a.source_name,
        "nx": numstr(a.source_nx),
        "ny": numstr(a.source_ny),
    }) or None
    out = {
        "id": a.ext_id,
        "tags": tags,
        "type": ev.problem if ev else None,
        "severity": ev.criticality if ev else None,
        "score": numstr(ev.score) if ev else None,
        "position": prune(
            {"x": numstr(a.px), "y": numstr(a.py), "z": numstr(a.pz)}
        ) or None,
        "location": a.location,
        "area": f"{numstr(ev.area_m2)} m²" if ev and ev.area_m2 is not None else None,
        "depth": numstr(ev.depth_m) if ev else None,
        "detected": ev.detected_on.isoformat() if ev and ev.detected_on else None,
        "action": ev.suggested_fix if ev else None,
        "image": url_of(crop.bucket, crop.object_path) if crop else None,
        "source": source,
    }
    return prune(out)


def photo_payload(s: Session, p: Photo) -> dict:
    img = s.get(Image, p.image_id)
    defects = []
    for an in s.scalars(
        select(Annotation).where(Annotation.photo_id == p.id).order_by(Annotation.created_at)
    ):
        region = an.region or {}
        defects.append(
            prune({
                "poly": region.get("points"),
                "tags": [an.label] if an.label else [],
                "sev": _severity_of(s, an),
            })
        )
    return prune({
        "id": img.sha256 if img else None,
        "url": url_of(img.bucket, img.object_path) if img else None,
        "name": p.name,
        "source": p.tile,
        "verdict": p.verdict if p.verdict != "pending" else None,
        "defects": defects if defects or p.verdict != "pending" else None,
    })


def _severity_of(s: Session, an: Annotation) -> Optional[str]:
    if not an.anomaly_id:
        return None
    a = s.get(Anomaly, an.anomaly_id)
    if not a or not a.current_evaluation_id:
        return None
    ev = s.get(Evaluation, a.current_evaluation_id)
    return ev.criticality if ev else None


def inspection_payload(s: Session, i: Inspection) -> dict:
    asset = s.get(Asset, i.asset_id)
    points = [
        point_payload(s, a)
        for a in s.scalars(
            select(Anomaly).where(Anomaly.inspection_id == i.id).order_by(Anomaly.created_at)
        )
    ]
    photos = [
        photo_payload(s, p)
        for p in s.scalars(
            select(Photo).where(Photo.inspection_id == i.id).order_by(Photo.created_at)
        )
    ]
    return prune({
        "asset": asset.slug if asset else None,
        "date": iso_z(i.captured_at),
        "points": points,
        "evaluatedAt": iso_z(i.evaluated_at),
        "evalPhotos": photos or None,
    })


def resolved_payload(s: Session, i: Inspection) -> dict:
    """{inspection, asset, composed} — the merge the browser used to do itself.

    Kept separate from the route so the parity check exercises this exact code
    rather than reimplementing the merge, which would let the two drift and the
    test still pass.
    """
    payload = inspection_payload(s, i)
    a = s.get(Asset, i.asset_id)
    asset = asset_payload(s, a) if a else None
    composed = {**(asset or {}), **payload}
    if asset:
        composed["project"] = asset.get("name")
    # The inspection's own scan wins over the asset's.
    #
    # `asset_payload` reports the LATEST inspection's model, which is what the
    # asset page should render. Merging it under an inspection meant asking for
    # inspection X and being handed inspection Y's scan — the landing carousel
    # asks for one featured inspection and got whichever flight was newest.
    # Invisible while every inspection of an asset points at the same blob, and
    # wrong the moment one of them is re-flown.
    #
    # Deliberately only in `composed`, not in `inspection_payload`: the legacy
    # files carry no model on an inspection, so emitting one from the raw
    # endpoint would break parity for no gain. Every consumer reads `composed`.
    composed.update(model_fields(s.get(Model3D, i.model_id)))
    return {"inspection": payload, "asset": asset, "composed": composed}


@router.get("/inspections")
def list_inspections(
    request: Request,
    s: Session = Depends(get_session),
    user: Optional[User] = Depends(optional_user),
) -> list[str]:
    # Baseline rows exist only to carry an asset's model; they were never files.
    rows = s.scalars(
        select(Inspection).where(Inspection.status != "draft").order_by(Inspection.slug)
    ).all()
    return [i.slug for i in rows if _may_read_inspection(s, user, request, i)]


@router.get("/inspections/{slug}")
def get_inspection(
    slug: str,
    request: Request,
    resolved: bool = False,
    s: Session = Depends(get_session),
    user: Optional[User] = Depends(optional_user),
) -> dict:
    """The inspection as stored, or the composed view the frontend actually uses.

    `?resolved=1` returns {inspection, asset, composed} in one round trip. The
    browser used to fetch both files and merge them itself, which only ever
    existed because GitHub Pages cannot join. `composed` reproduces that merge
    exactly: asset fields, overridden by inspection fields, plus `project`.
    """
    i = s.scalar(select(Inspection).where(Inspection.slug == slug))
    if not i:
        raise HTTPException(404, "inspection not found")
    if not _may_read_inspection(s, user, request, i):
        raise _forbid(user)
    return resolved_payload(s, i) if resolved else inspection_payload(s, i)


# ───────────────────────── landing and tasks ───────────────────────────

@router.get("/landing-models")
def landing_models(s: Session = Depends(get_session)) -> dict:
    # The carousel is on the public landing page, so only public inspections
    # belong here — being featured does not override visibility.
    slugs = list(
        s.scalars(
            select(Inspection.slug)
            .join(Featured, Featured.inspection_id == Inspection.id)
            .where(Inspection.visibility == "public")
            .order_by(Featured.position)
        )
    )
    return {"inspections": slugs}


@router.get("/inspections/{slug}/tasks")
def list_inspection_tasks(
    slug: str,
    request: Request,
    s: Session = Depends(get_session),
    user: Optional[User] = Depends(optional_user),
) -> dict:
    """Tasks for one inspection, newest first.

    Replaces listing the `tasks/` directory through the GitHub contents API and
    filtering filenames by prefix — which needed a repo token in the browser to
    read data that is ours.
    """
    i = s.scalar(select(Inspection).where(Inspection.slug == slug))
    if not i:
        raise HTTPException(404, "inspection not found")
    if not _may_read_inspection(s, user, request, i):
        raise _forbid(user)
    rows = s.scalars(
        select(EvalTask)
        .where(EvalTask.inspection_id == i.id)
        .order_by(EvalTask.created_at.desc())
    ).all()
    return {
        "tasks": [
            {"id": t.legacy_id, "kind": t.kind, "status": t.status,
             "created_at": iso_z(t.created_at)}
            for t in rows
        ]
    }


@router.get("/tasks/{legacy_id}")
def get_task(legacy_id: str, s: Session = Depends(get_session)) -> dict:
    t = s.scalar(select(EvalTask).where(EvalTask.legacy_id == legacy_id))
    if not t:
        raise HTTPException(404, "task not found")
    insp = s.get(Inspection, t.inspection_id)
    out = {
        "id": t.legacy_id,
        "kind": t.kind,
        "status": t.status,
        "createdAt": iso_z(t.created_at),
        "inspection": insp.slug if insp else None,
        "source": t.source,
        "align": t.align,
    }
    out.update(t.payload or {})
    return prune(out)
