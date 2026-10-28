"""Share links: revocable, expiring access to one inspection.

What this adds over `visibility='link'` is the ability to take it back. Today a
leaked URL is permanent, because the slug IS the capability and the only way to
revoke it is to rename the inspection. A share token can be expired or revoked
without touching the inspection or breaking anyone else's link.
"""
from __future__ import annotations

import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from api.auth.deps import optional_user, require_asset_role, require_user
from api.db import get_session
from api.models import Asset, Inspection, ShareLink, User

router = APIRouter(prefix="/api", tags=["share"])

TOKEN_PARAM = "t"


class ShareRequest(BaseModel):
    expires_in_days: Optional[int] = Field(default=None, ge=1, le=3650)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def valid_token(db: DbSession, token: Optional[str], inspection: Inspection) -> bool:
    """Whether `token` currently grants access to `inspection`."""
    if not token:
        return False
    row = db.get(ShareLink, token)
    if row is None or row.inspection_id != inspection.id:
        return False
    if row.revoked_at is not None:
        return False
    if row.expires_at is not None and row.expires_at <= _now():
        return False
    return True


def token_from(request: Request) -> Optional[str]:
    return request.query_params.get(TOKEN_PARAM)


@router.post("/inspections/{slug}/share")
def create_share(
    slug: str,
    body: ShareRequest,
    request: Request,
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    insp = db.scalar(select(Inspection).where(Inspection.slug == slug))
    if not insp:
        raise HTTPException(404, "inspection not found")
    asset = db.get(Asset, insp.asset_id)
    require_asset_role(db, user, asset, "editor")

    token = secrets.token_urlsafe(24)
    expires_at = (
        _now() + timedelta(days=body.expires_in_days) if body.expires_in_days else None
    )
    db.add(
        ShareLink(
            token=token,
            inspection_id=insp.id,
            expires_at=expires_at,
            created_by=user.id,
        )
    )
    db.commit()
    base = str(request.base_url).rstrip("/")
    return {
        "token": token,
        "url": f"{base}/inspection/{slug}?{TOKEN_PARAM}={token}",
        "expires_at": expires_at.isoformat() if expires_at else None,
    }


@router.get("/inspections/{slug}/shares")
def list_shares(
    slug: str, user: User = Depends(require_user), db: DbSession = Depends(get_session)
) -> dict:
    insp = db.scalar(select(Inspection).where(Inspection.slug == slug))
    if not insp:
        raise HTTPException(404, "inspection not found")
    require_asset_role(db, user, db.get(Asset, insp.asset_id), "editor")
    rows = db.scalars(
        select(ShareLink).where(ShareLink.inspection_id == insp.id).order_by(ShareLink.created_at)
    ).all()
    return {
        "shares": [
            {
                # Never the whole token: this listing is for deciding what to
                # revoke, and a token printed in a log or screenshot is a key.
                "token_hint": f"…{r.token[-6:]}",
                "token": r.token if r.revoked_at is None else None,
                "created_at": r.created_at.isoformat() if r.created_at else None,
                "expires_at": r.expires_at.isoformat() if r.expires_at else None,
                "revoked": r.revoked_at is not None,
            }
            for r in rows
        ]
    }


@router.delete("/shares/{token}")
def revoke_share(
    token: str, user: User = Depends(require_user), db: DbSession = Depends(get_session)
) -> dict:
    row = db.get(ShareLink, token)
    if row is None:
        raise HTTPException(404, "share link not found")
    insp = db.get(Inspection, row.inspection_id)
    require_asset_role(db, user, db.get(Asset, insp.asset_id), "editor")
    if row.revoked_at is None:
        row.revoked_at = _now()
        db.commit()
    return {"ok": True, "revoked": True}
