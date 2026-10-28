"""Request dependencies for identity and authorisation.

Authorisation answers one question — what may THIS user do with THIS asset —
and it answers it in one place. Access can be granted to the user directly or
to an org they belong to; both are checked here so no caller has to remember
that there are two tables.
"""
from __future__ import annotations

from typing import Optional

from fastapi import Depends, HTTPException, Request, Response
from sqlalchemy import or_, select
from sqlalchemy.orm import Session as DbSession

from api.auth import sessions
from api.db import get_session
from api.models import Asset, AssetOrgAccess, AssetUserAccess, Membership, User

# Ordered weakest to strongest; an `editor` grant satisfies a `viewer` requirement.
ROLE_RANK = {"viewer": 0, "labeler": 1, "editor": 2}


def optional_user(
    request: Request, response: Response, db: DbSession = Depends(get_session)
) -> Optional[User]:
    return sessions.current(db, request, response)


def require_user(user: Optional[User] = Depends(optional_user)) -> User:
    if user is None:
        raise HTTPException(401, "authentication required")
    return user


def require_admin(user: User = Depends(require_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "admin only")
    return user


def asset_role(db: DbSession, user: Optional[User], asset: Asset) -> Optional[str]:
    """The strongest role `user` holds on `asset`, or None.

    Platform admins hold `editor` on everything — that is what `role='admin'`
    means, and spelling it here keeps every caller from special-casing it.
    """
    if user is None:
        return None
    if user.role == "admin":
        return "editor"
    direct = db.scalar(
        select(AssetUserAccess.role).where(
            AssetUserAccess.asset_id == asset.id, AssetUserAccess.user_id == user.id
        )
    )
    via_org = db.scalar(
        select(AssetOrgAccess.role)
        .join(Membership, Membership.org_id == AssetOrgAccess.org_id)
        .where(AssetOrgAccess.asset_id == asset.id, Membership.user_id == user.id)
    )
    roles = [r for r in (direct, via_org) if r]
    return max(roles, key=lambda r: ROLE_RANK.get(r, -1)) if roles else None


# Sentinel for "work the role out yourself", distinct from `None`, which is a
# real answer meaning "holds no role".
_UNKNOWN = object()


def may_read(
    db: DbSession, user: Optional[User], asset: Asset, role=_UNKNOWN
) -> bool:
    """Whether `user` may open `asset`. The one definition of that rule.

    `link` is not open here: an asset is the hub page, not a delivered
    artefact, and the capability a client holds points at one inspection.

    Pass `role` when it is already known. A route that lists assets resolves
    every role in two queries up front; without this it would resolve each one
    twice, once for the answer and once for the label.
    """
    if asset.visibility == "public":
        return True
    if role is _UNKNOWN:
        role = asset_role(db, user, asset)
    return role is not None


def may_manage_access(user: Optional[User], asset: Optional[Asset] = None) -> bool:
    """Who may change WHO CAN SEE an asset. Platform admins, and nobody else.

    Deliberately NOT `editor`. The roles above describe what someone may do
    with the CONTENT of an asset; handing out access is a different power, and
    it is the one that compounds: an editor who could grant `editor` could put
    anyone at all inside a client's private asset, including themselves on
    assets they were never given. Role names have to mean what they say, and
    `editor` says editor.

    `asset` is unused today and is in the signature because the rule is
    per-asset in principle: the obvious next step is letting the owner of a
    client org invite their own colleagues to their own asset. When that
    arrives it changes here, and every caller follows.
    """
    return user is not None and user.role == "admin"


def require_access_manager(user: User = Depends(require_user)) -> User:
    if not may_manage_access(user):
        raise HTTPException(403, "managing access requires platform admin")
    return user


def require_asset_role(db: DbSession, user: Optional[User], asset: Asset, needed: str) -> str:
    held = asset_role(db, user, asset)
    if held is None or ROLE_RANK.get(held, -1) < ROLE_RANK[needed]:
        raise HTTPException(
            401 if user is None else 403,
            f"{needed} access to asset '{asset.slug}' required",
        )
    return held
