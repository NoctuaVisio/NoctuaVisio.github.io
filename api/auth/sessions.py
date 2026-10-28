"""Server-side sessions.

The browser gets an opaque random token in an HttpOnly cookie; the database
stores only its SHA-256. Two consequences worth stating:

* A leaked database dump cannot be replayed as a login.
* Logging out is a real revocation, not an expiry the server cannot enforce —
  which is the thing a self-contained JWT cannot give us.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from api.models import Session as SessionRow
from api.models import User

COOKIE_NAME = "noctua_session"
LIFETIME = timedelta(days=30)
# Re-stamp the cookie only once a day; writing it on every request would mean a
# database UPDATE per page view for no benefit.
REFRESH_AFTER = timedelta(days=1)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def issue(db: DbSession, user: User, request: Request, response: Response) -> SessionRow:
    token = secrets.token_urlsafe(32)
    row = SessionRow(
        user_id=user.id,
        token_hash=_hash(token),
        expires_at=_now() + LIFETIME,
        last_used_at=_now(),
        user_agent=(request.headers.get("user-agent") or "")[:400] or None,
        ip=request.headers.get("x-forwarded-for", "").split(",")[0].strip() or None,
    )
    db.add(row)
    user.last_seen_at = _now()
    db.flush()
    _set_cookie(request, response, token)
    return row


def _set_cookie(request: Request, response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=int(LIFETIME.total_seconds()),
        httponly=True,
        # Lax, not Strict: the OAuth callback is a cross-site navigation back to
        # us, and Strict would drop the cookie exactly then.
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )


def current(db: DbSession, request: Request, response: Optional[Response] = None) -> Optional[User]:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        return None
    row = db.scalar(select(SessionRow).where(SessionRow.token_hash == _hash(token)))
    if not row or row.revoked_at is not None or row.expires_at <= _now():
        return None
    if response is not None and (
        row.last_used_at is None or _now() - row.last_used_at > REFRESH_AFTER
    ):
        row.last_used_at = _now()
        row.expires_at = _now() + LIFETIME
        db.flush()
        _set_cookie(request, response, token)
    return db.get(User, row.user_id)


def revoke(db: DbSession, request: Request, response: Response) -> bool:
    token = request.cookies.get(COOKIE_NAME)
    response.delete_cookie(COOKIE_NAME, path="/")
    if not token:
        return False
    row = db.scalar(select(SessionRow).where(SessionRow.token_hash == _hash(token)))
    if not row or row.revoked_at is not None:
        return False
    row.revoked_at = _now()
    db.flush()
    return True


def revoke_all(db: DbSession, user: User) -> int:
    rows = db.scalars(
        select(SessionRow).where(
            SessionRow.user_id == user.id, SessionRow.revoked_at.is_(None)
        )
    ).all()
    for row in rows:
        row.revoked_at = _now()
    db.flush()
    return len(rows)
