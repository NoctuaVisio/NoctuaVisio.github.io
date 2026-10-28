"""Who may do what with an asset.

Granting is the point of this file: an admin hands access to a USER or to an
ORG, and the two live in separate tables so each has a real foreign key rather
than a polymorphic subject id that nothing can enforce.

**Managing access takes a platform admin, not an asset `editor`.** It used to
take `editor`, which meant an editor on one asset could grant `editor` on that
asset to anybody, themselves included and any outsider besides. Handing out
access is a different power from editing the thing, and the larger one. The
rule lives in `deps.may_manage_access` so the API and the UI read the same
sentence.

Granting to an email that has no account yet is deliberate and is how inviting
works: the user row is created with no `identities` row, so it cannot be signed
in to. When that person signs in with Google using the same verified address,
the existing matching rule attaches the identity to this row — and the access
granted today is already waiting. No invitation token, no expiry, nothing to
deliver.
"""
from __future__ import annotations

from typing import Literal, Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from api.auth.deps import require_access_manager, require_admin, require_user
from api.db import get_session
from api.models import (
    Asset,
    Identity,
    AssetOrgAccess,
    AssetUserAccess,
    AuditLog,
    Membership,
    Org,
    User,
)

router = APIRouter(prefix="/api", tags=["access"])

Role = Literal["editor", "labeler", "viewer"]


class GrantRequest(BaseModel):
    role: Role = "viewer"
    # Exactly one of these. Email may belong to somebody who has never signed
    # in; see the module docstring.
    email: Optional[EmailStr] = None
    org: Optional[str] = Field(default=None, max_length=80)


def _audit(db: DbSession, user: User, action: str, subject: str, meta: dict) -> None:
    db.add(AuditLog(user_id=user.id, action=action, subject_type="asset",
                    subject_id=subject, meta=meta))


def _asset_or_404(db: DbSession, slug: str) -> Asset:
    a = db.scalar(select(Asset).where(Asset.slug == slug))
    if a is None:
        raise HTTPException(404, "asset not found")
    return a


@router.get("/assets/{slug}/access")
def list_access(
    slug: str,
    user: User = Depends(require_access_manager),
    db: DbSession = Depends(get_session),
) -> dict:
    asset = _asset_or_404(db, slug)
    # `has_identity` is the honest signal for "has this person ever signed in":
    # an invited user exists as a row with no identity until their first login.
    users = db.execute(
        select(
            User.email, User.name, User.kind, AssetUserAccess.role,
            select(Identity.id).where(Identity.user_id == User.id).exists().label("has_identity"),
        )
        .join(AssetUserAccess, AssetUserAccess.user_id == User.id)
        .where(AssetUserAccess.asset_id == asset.id)
        .order_by(User.email)
    ).all()
    orgs = db.execute(
        select(Org.slug, Org.name, AssetOrgAccess.role)
        .join(AssetOrgAccess, AssetOrgAccess.org_id == Org.id)
        .where(AssetOrgAccess.asset_id == asset.id)
        .order_by(Org.slug)
    ).all()
    return {
        "visibility": asset.visibility,
        "users": [
            # `pending` says the grant is real but the account is a placeholder
            # waiting for a first login.
            {"email": e, "name": n, "role": r, "kind": k, "pending": not has_id}
            for e, n, k, r, has_id in users
        ],
        "orgs": [{"slug": s, "name": n, "role": r} for s, n, r in orgs],
    }


@router.put("/assets/{slug}/access")
def grant_access(
    slug: str,
    body: GrantRequest,
    user: User = Depends(require_access_manager),
    db: DbSession = Depends(get_session),
) -> dict:
    asset = _asset_or_404(db, slug)
    if bool(body.email) == bool(body.org):
        raise HTTPException(400, "give exactly one of email or org")

    if body.org:
        org = db.scalar(select(Org).where(Org.slug == body.org))
        if org is None:
            raise HTTPException(404, f"org '{body.org}' does not exist")
        row = db.get(AssetOrgAccess, {"asset_id": asset.id, "org_id": org.id})
        if row is None:
            db.add(AssetOrgAccess(asset_id=asset.id, org_id=org.id,
                                  role=body.role, granted_by=user.id))
        else:
            row.role = body.role
        _audit(db, user, "access.grant.org", slug, {"org": org.slug, "role": body.role})
        db.commit()
        return {"ok": True, "org": org.slug, "role": body.role}

    email = str(body.email).lower()
    target = db.scalar(select(User).where(User.email == email))
    created = False
    if target is None:
        target = User(email=email, kind="human", role="normal")
        db.add(target)
        db.flush()
        created = True
    elif target.kind != "human":
        raise HTTPException(400, "that address belongs to a non-human account")

    row = db.get(AssetUserAccess, {"asset_id": asset.id, "user_id": target.id})
    if row is None:
        db.add(AssetUserAccess(asset_id=asset.id, user_id=target.id,
                               role=body.role, granted_by=user.id))
    else:
        row.role = body.role
    _audit(db, user, "access.grant.user", slug,
           {"email": email, "role": body.role, "invited": created})
    db.commit()
    return {"ok": True, "email": email, "role": body.role, "invited": created}


@router.delete("/assets/{slug}/access")
def revoke_access(
    slug: str,
    email: Optional[str] = None,
    org: Optional[str] = None,
    user: User = Depends(require_access_manager),
    db: DbSession = Depends(get_session),
) -> dict:
    asset = _asset_or_404(db, slug)
    if bool(email) == bool(org):
        raise HTTPException(400, "give exactly one of email or org")

    if org:
        o = db.scalar(select(Org).where(Org.slug == org))
        row = db.get(AssetOrgAccess, {"asset_id": asset.id, "org_id": o.id}) if o else None
        if row is not None:
            db.delete(row)
        _audit(db, user, "access.revoke.org", slug, {"org": org})
    else:
        t = db.scalar(select(User).where(User.email == str(email).lower()))
        row = db.get(AssetUserAccess, {"asset_id": asset.id, "user_id": t.id}) if t else None
        if row is not None:
            db.delete(row)
        _audit(db, user, "access.revoke.user", slug, {"email": email})
    db.commit()
    return {"ok": True}


@router.get("/orgs")
def list_orgs(
    user: User = Depends(require_user), db: DbSession = Depends(get_session)
) -> dict:
    """Orgs to choose from when granting. Admins see all; everyone else sees
    the ones they belong to, because you cannot grant to an org you cannot see."""
    members = (
        select(func.count(Membership.user_id))
        .where(Membership.org_id == Org.id)
        .correlate(Org)
        .scalar_subquery()
    )
    # The count is here because an org with no members grants nothing, and
    # choosing one without knowing that is how "I gave access and nothing
    # happened" starts.
    q = select(Org.slug, Org.name, members.label("members")).order_by(Org.name)
    if user.role != "admin":
        q = q.join(Membership, Membership.org_id == Org.id).where(Membership.user_id == user.id)
    return {"orgs": [{"slug": s, "name": n, "members": m} for s, n, m in db.execute(q).all()]}


class OrgRequest(BaseModel):
    slug: str = Field(min_length=2, max_length=60, pattern=r"^[a-z0-9][a-z0-9-]*$")
    name: str = Field(min_length=1, max_length=120)


@router.post("/orgs")
def create_org(
    body: OrgRequest,
    user: User = Depends(require_admin),
    db: DbSession = Depends(get_session),
) -> dict:
    if db.scalar(select(Org).where(Org.slug == body.slug)):
        raise HTTPException(409, f"org '{body.slug}' already exists")
    org = Org(slug=body.slug, name=body.name)
    db.add(org)
    db.add(AuditLog(user_id=user.id, action="org.create", subject_type="org",
                    subject_id=body.slug, meta={"name": body.name}))
    db.commit()
    return {"ok": True, "slug": org.slug, "name": org.name}


# ───────────────────────── org membership ──────────────────────────
# Granting an asset to an org does nothing until someone is IN the org, and
# there was no way to put them there — which made the org half of the access
# model decorative. These three routes are what make it mean something.

class MemberRequest(BaseModel):
    email: EmailStr
    role: Literal["owner", "member"] = "member"


@router.get("/orgs/{slug}/members")
def list_members(
    slug: str,
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    org = db.scalar(select(Org).where(Org.slug == slug))
    if org is None:
        raise HTTPException(404, "org not found")
    _require_org_admin(db, user, org)
    rows = db.execute(
        select(
            User.email, User.name, Membership.role,
            select(Identity.id).where(Identity.user_id == User.id).exists().label("has_identity"),
        )
        .join(Membership, Membership.user_id == User.id)
        .where(Membership.org_id == org.id)
        .order_by(User.email)
    ).all()
    return {
        "org": {"slug": org.slug, "name": org.name},
        "members": [
            {"email": e, "name": n, "role": r, "pending": not has_id}
            for e, n, r, has_id in rows
        ],
    }


@router.put("/orgs/{slug}/members")
def add_member(
    slug: str,
    body: MemberRequest,
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    """Same invite semantics as an asset grant: an address with no account gets
    a row it cannot sign in to, and the first login with that verified address
    picks up both the membership and whatever the org can reach."""
    org = db.scalar(select(Org).where(Org.slug == slug))
    if org is None:
        raise HTTPException(404, "org not found")
    _require_org_admin(db, user, org)

    email = str(body.email).lower()
    target = db.scalar(select(User).where(User.email == email))
    created = False
    if target is None:
        target = User(email=email, kind="human", role="normal")
        db.add(target)
        db.flush()
        created = True
    elif target.kind != "human":
        raise HTTPException(400, "that address belongs to a non-human account")

    row = db.get(Membership, {"org_id": org.id, "user_id": target.id})
    if row is None:
        db.add(Membership(org_id=org.id, user_id=target.id,
                          role=body.role, invited_by=user.id))
    else:
        row.role = body.role
    db.add(AuditLog(user_id=user.id, action="org.member.add", subject_type="org",
                    subject_id=slug, meta={"email": email, "role": body.role,
                                           "invited": created}))
    db.commit()
    return {"ok": True, "email": email, "role": body.role, "invited": created}


@router.delete("/orgs/{slug}/members")
def remove_member(
    slug: str,
    email: str,
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    org = db.scalar(select(Org).where(Org.slug == slug))
    if org is None:
        raise HTTPException(404, "org not found")
    _require_org_admin(db, user, org)
    target = db.scalar(select(User).where(User.email == str(email).lower()))
    row = db.get(Membership, {"org_id": org.id, "user_id": target.id}) if target else None
    if row is not None:
        db.delete(row)
    db.add(AuditLog(user_id=user.id, action="org.member.remove", subject_type="org",
                    subject_id=slug, meta={"email": email}))
    db.commit()
    return {"ok": True}


def _require_org_admin(db: DbSession, user: User, org: Org) -> None:
    """Platform admins, or an owner of this org. A plain member can see the
    asset the org reaches but cannot change who else does."""
    if user.role == "admin":
        return
    role = db.scalar(
        select(Membership.role).where(
            Membership.org_id == org.id, Membership.user_id == user.id
        )
    )
    if role != "owner":
        raise HTTPException(403, "org owner or platform admin required")
