"""Signing in with any email address, no provider required.

Google and Microsoft cover a lot of people and not everybody. A client on a
company domain that runs neither is the case that matters, and for them the
address itself is the credential: only its owner reads the message, so a
single-use link sent there proves as much as an OIDC callback does.

Three things this file is careful about, because each is a real hole:

* **Account enumeration.** Requesting a link answers the same way whether the
  address is known, unknown, invited-but-never-signed-in, or the detector. The
  response never says which. An endpoint that answered differently would be a
  free "is this person a Noctua client" oracle for anyone.

* **Rate limiting.** Without it, this endpoint is a way to send mail from our
  domain to an arbitrary address as often as the attacker likes, which burns
  the domain's reputation and is a nuisance to the recipient. Limited per
  address, in the database, because Cloud Run runs several instances and
  anything in process memory is per-instance and therefore not a limit.

* **Single use and short life.** The token is consumed on redemption and lives
  fifteen minutes. A mail archive is not a credential store.

What it deliberately does NOT do is create an account. A link to an address
that has no `users` row signs nobody in. Access here is granted by an admin
first — the invite flow in `routes/access.py` already creates the row — so this
cannot become a self-service door into the platform.
"""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import func, select
from sqlalchemy.orm import Session as DbSession

from api.models import Identity, LoginToken, User

LIFETIME = timedelta(minutes=15)
# Per address, per window. Three is enough for "it did not arrive, try again"
# and far short of useful for anyone sending mail they should not.
MAX_PER_WINDOW = 3
WINDOW = timedelta(minutes=15)

PROVIDER = "email"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def recent_count(db: DbSession, email: str) -> int:
    return db.scalar(
        select(func.count(LoginToken.id)).where(
            LoginToken.email == email, LoginToken.created_at > _now() - WINDOW
        )
    ) or 0


def issue(
    db: DbSession,
    email: str,
    next_path: str,
    ip: Optional[str] = None,
    user_agent: Optional[str] = None,
) -> Optional[str]:
    """A fresh token for `email`, or None when no link should be sent.

    None covers both "no such account" and "asked too often". The caller must
    answer identically either way; see the note on enumeration above.
    """
    email = email.strip().lower()
    user = db.scalar(select(User).where(User.email == email))
    # `kind != human` is the detector and service accounts. They have no inbox
    # and must never be reachable by a login flow.
    if user is None or user.kind != "human":
        return None
    if recent_count(db, email) >= MAX_PER_WINDOW:
        return None

    token = secrets.token_urlsafe(32)
    db.add(
        LoginToken(
            token_hash=_hash(token),
            email=email,
            next_path=next_path,
            expires_at=_now() + LIFETIME,
            requested_ip=ip,
            requested_ua=(user_agent or "")[:400] or None,
        )
    )
    db.flush()
    return token


class Rejected(Exception):
    """Why a link could not be redeemed, in words a person can act on."""

    def __init__(self, reason: str, message: str):
        super().__init__(message)
        self.reason = reason
        self.message = message


def redeem(db: DbSession, token: str) -> tuple[User, str]:
    """Consume `token` and return the user plus where to send them.

    Distinguishes expired from already-used from never-valid, because they call
    for different actions: ask for a new link, check whether you are already
    signed in somewhere, or look at the address you typed.
    """
    row = db.scalar(select(LoginToken).where(LoginToken.token_hash == _hash(token)))
    if row is None:
        raise Rejected("invalid", "This link is not valid.")
    if row.consumed_at is not None:
        raise Rejected("used", "This link has already been used.")
    if row.expires_at <= _now():
        raise Rejected("expired", "This link has expired.")

    user = db.scalar(select(User).where(User.email == row.email))
    if user is None or user.kind != "human":
        # The account went away between the request and the click.
        raise Rejected("gone", "The account for this link no longer exists.")

    # Consumed before the session is minted, inside the same transaction: two
    # clicks arriving together cannot both win.
    row.consumed_at = _now()

    # Record the identity the first time, so `/auth/me` and the account page can
    # say how this person signs in. `provider_sub` is the address because that
    # is what identifies them in this scheme.
    existing = db.scalar(
        select(Identity).where(
            Identity.provider == PROVIDER, Identity.provider_sub == row.email
        )
    )
    if existing is None:
        db.add(
            Identity(
                user_id=user.id, provider=PROVIDER,
                provider_sub=row.email, email=row.email,
            )
        )
    db.flush()
    return user, row.next_path
