"""One endpoint behind the one hub page.

/assets/, /inspections/ and /admin/ used to be three pages that each rebuilt
the same grid from the same data, differing only in which rows they threw away
afterwards. The public pair discarded everything that was not `public`, which
is why an asset granted to a person never appeared for them: the API returned
it and the page filtered it out.

There is now a single hub, and this is what it reads. It answers in one round
trip what the old pages asked for in roughly `2 + 3N` of them: the viewer's
identity, every asset they may open with the role they hold on it, every
inspection inside those assets, the point counts, which are featured on the
landing, and which carry a pending evaluation.

Authorisation is identical to `legacy.py`, and deliberately shares
`_may_read_asset` / `_may_read_inspection` with it rather than restating the
rules — two copies of a visibility ladder is one copy too many.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Request
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from api.auth.deps import ROLE_RANK, may_manage_access, may_read, optional_user
from api.db import get_session
from api.models import (
    Anomaly,
    Asset,
    AssetOrgAccess,
    AssetUserAccess,
    EvalTask,
    Featured,
    Image,
    Inspection,
    Membership,
    Model3D,
    User,
)
from api.routes.legacy import _may_read_inspection, iso_z, url_of

router = APIRouter(prefix="/api", tags=["hub"])


def _roles_for(db: Session, user: Optional[User]) -> dict:
    """Every asset_id → strongest role this user holds, in two queries.

    `asset_role()` answers for one asset and costs two queries each time, which
    is the right shape for a route that touches a single asset and the wrong one
    for a list. The ranking rule is read from ROLE_RANK so the two cannot drift.
    """
    if user is None:
        return {}
    if user.role == "admin":
        return {}      # admins hold editor on everything; see _role_of below
    out: dict = {}

    def keep(asset_id, role):
        cur = out.get(asset_id)
        if cur is None or ROLE_RANK.get(role, -1) > ROLE_RANK.get(cur, -1):
            out[asset_id] = role

    for asset_id, role in db.execute(
        select(AssetUserAccess.asset_id, AssetUserAccess.role).where(
            AssetUserAccess.user_id == user.id
        )
    ):
        keep(asset_id, role)
    for asset_id, role in db.execute(
        select(AssetOrgAccess.asset_id, AssetOrgAccess.role)
        .join(Membership, Membership.org_id == AssetOrgAccess.org_id)
        .where(Membership.user_id == user.id)
    ):
        keep(asset_id, role)
    return out


def _role_of(user: Optional[User], roles: dict, asset: Asset) -> Optional[str]:
    if user is None:
        return None
    if user.role == "admin":
        return "editor"
    return roles.get(asset.id)


@router.get("/hub")
def hub(
    request: Request,
    s: Session = Depends(get_session),
    user: Optional[User] = Depends(optional_user),
) -> dict:
    """Everything the hub grid renders, in one answer.

    Fields are named the way `NoctuaCard` already reads them, so the page hands
    rows straight to the renderer instead of reshaping them. `role` is what the
    affordances key off: it is resolved on the server, because a browser that
    decides for itself what it may edit decides wrong the moment someone edits
    the page.
    """
    assets = s.scalars(select(Asset).order_by(Asset.slug)).all()
    roles = _roles_for(s, user)

    visible = []
    for a in assets:
        role = _role_of(user, roles, a)
        if may_read(s, user, a, role):
            visible.append((a, role))
    visible_ids = [a.id for a, _ in visible]

    # ── everything about the inspections inside those assets, in bulk ──────
    insps = (
        s.scalars(
            select(Inspection)
            .where(Inspection.asset_id.in_(visible_ids), Inspection.status != "draft")
            .order_by(Inspection.captured_at.desc().nullslast(), Inspection.slug)
        ).all()
        if visible_ids
        else []
    )
    insps = [i for i in insps if _may_read_inspection(s, user, request, i)]
    insp_ids = [i.id for i in insps]

    # `.all()` matters: a Result exposes `.keys()`, so dict() takes it for a
    # mapping and subscripts it instead of iterating the rows.
    points = dict(
        s.execute(
            select(Anomaly.inspection_id, func.count())
            .where(Anomaly.inspection_id.in_(insp_ids))
            .group_by(Anomaly.inspection_id)
        ).all()
        if insp_ids
        else []
    )
    featured = set(
        s.scalars(
            select(Featured.inspection_id).where(Featured.inspection_id.in_(insp_ids))
        )
        if insp_ids
        else []
    )
    # The newest open task per inspection; `status != done` is the same signal
    # the card's "Unfinished" badge and "Evaluate" button both read.
    pending: dict = {}
    if insp_ids:
        for insp_id, legacy_id in s.execute(
            select(EvalTask.inspection_id, EvalTask.legacy_id)
            .where(EvalTask.inspection_id.in_(insp_ids), EvalTask.status != "done")
            .order_by(EvalTask.created_at.desc())
        ):
            pending.setdefault(insp_id, legacy_id)

    # Thumbnails and model kinds, one query each rather than one per row.
    thumb_ids = {a.thumbnail_id for a, _ in visible if a.thumbnail_id}
    thumb_ids |= {i.thumbnail_id for i in insps if i.thumbnail_id}
    thumbs = {
        im.id: url_of(im.bucket, im.object_path)
        for im in (
            s.scalars(select(Image).where(Image.id.in_(thumb_ids))) if thumb_ids else []
        )
    }
    # Splat or GLB, per asset.
    #
    # Taken from the asset's latest scan whatever its status, not from the
    # inspections above: those exclude drafts, and the `<slug>-baseline` row
    # that carries the model of an asset with no survey yet IS a draft. Reading
    # only published rows badged such an asset as GLB on the card while the
    # viewer rendered a splat — the two disagreeing about the same asset.
    #
    # Matches `legacy.asset_payload`, which picks the model the same way.
    kind_rows = (
        s.execute(
            select(Inspection.asset_id, Model3D.kind)
            .join(Model3D, Model3D.id == Inspection.model_id)
            .where(Inspection.asset_id.in_(visible_ids))
            .order_by(Inspection.captured_at.desc().nullslast())
        ).all()
        if visible_ids
        else []
    )
    kinds: dict = {}
    for asset_id, kind in kind_rows:
        kinds.setdefault(asset_id, kind)

    grouped: dict = {}
    for i in insps:
        grouped.setdefault(i.asset_id, []).append(i)

    def insp_row(i: Inspection, a: Asset, may_edit: bool) -> dict:
        return {
            "slug": i.slug,
            "project": a.name,
            "asset": a.slug,
            "thumbnail": thumbs.get(i.thumbnail_id) or thumbs.get(a.thumbnail_id),
            "date": iso_z(i.captured_at),
            "points": points.get(i.id, 0),
            "visibility": i.visibility,
            "access": "open" if i.visibility == "public" else "protected",
            "featured": i.id in featured,
            # Whether an evaluation is still open is operator information, and
            # the only button that reads it is one a viewer does not get.
            "pendingTask": pending.get(i.id) if may_edit else None,
        }

    out = []
    for a, role in visible:
        rows = grouped.get(a.id, [])
        can_edit = role is not None and ROLE_RANK.get(role, -1) >= ROLE_RANK["editor"]
        insp_rows = [insp_row(i, a, can_edit) for i in rows]
        kind = kinds.get(a.id)
        out.append({
            "slug": a.slug,
            "project": a.name,
            "thumbnail": thumbs.get(a.thumbnail_id),
            "date": iso_z(a.created_at),
            "visibility": a.visibility,
            "access": "open" if a.visibility == "public" else "protected",
            "isOpen": a.visibility == "public",
            "kind": "splat" if kind == "splat" else "glb",
            "role": role,
            "canEdit": can_edit,
            # Separate from canEdit on purpose: editing the asset and deciding
            # who may see it are different powers, and the UI must not infer
            # one from the other. Same predicate the access routes enforce.
            "canManageAccess": may_manage_access(user, a),
            "featured": any(r["featured"] for r in insp_rows),
            "inspections": insp_rows,
        })

    return {
        "user": None
        if user is None
        else {
            "email": user.email,
            "name": user.name,
            "role": user.role,
            "isAdmin": user.role == "admin",
        },
        # Only admins create assets. An editor edits what they were given.
        "canCreate": user is not None and user.role == "admin",
        "assets": out,
    }
