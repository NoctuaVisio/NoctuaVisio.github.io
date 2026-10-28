"""Login, logout and identity.

The flow: /auth/<provider>/start redirects to the provider, the provider comes
back to /auth/<provider>/callback, we match or create the user, mint a session
and send the browser where it was going.

Account matching is deliberate. An identity (provider + subject) is the key. A
*verified* email also links a second provider to the same account, so signing in
with Microsoft after Google lands on one user rather than two. An unverified
email never links, because that would let anyone who can claim an address at a
sloppy provider take over an existing account.

A third way in lives in `api/auth/email_link.py`: a single-use link sent to the
address itself, for the people whose company runs neither Google nor Microsoft.
It signs in an existing account and never creates one.
"""
from __future__ import annotations

import base64
import json
import secrets
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlencode, urlparse

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import HTMLResponse, RedirectResponse
from pydantic import BaseModel, EmailStr
from sqlalchemy import select
from sqlalchemy.orm import Session as DbSession

from api import mail
from api.auth import email_link, sessions
from api.auth.deps import optional_user, require_user
from api.auth.providers import PROVIDERS, Provider, enabled_providers
from api.db import get_session
from api.models import Identity, Membership, Org, User

router = APIRouter(prefix="/auth", tags=["auth"])

STATE_COOKIE = "noctua_oauth_state"


def _provider_or_404(name: str) -> Provider:
    p = PROVIDERS.get(name)
    if p is None:
        raise HTTPException(404, f"unknown provider '{name}'")
    if not p.enabled:
        raise HTTPException(503, f"provider '{name}' is not configured")
    return p


def _redirect_uri(request: Request, name: str) -> str:
    # Built from the request so the same image works on every hostname Cloud Run
    # answers on, and locally, without a per-environment setting.
    return str(request.url_for("oauth_callback", provider=name))


def _safe_next(raw: Optional[str]) -> str:
    """Only same-site paths. An open redirect here would be a phishing primitive."""
    if not raw:
        return "/"
    parsed = urlparse(raw)
    if parsed.scheme or parsed.netloc or not raw.startswith("/"):
        return "/"
    return raw


def _id_token_claims(id_token: str) -> dict:
    """Read the id_token payload without verifying its signature.

    Deliberate, and what OIDC Core 3.1.3.7 allows: this token came straight
    from the provider's token endpoint over TLS, in response to a request
    carrying our client_secret. There is no third party in that path whose
    signature we would be checking. Signature verification matters when an
    id_token arrives by another route (an implicit flow, or passed to us by a
    client) — and if we ever accept one that way, it must be verified against
    the provider's JWKS before being trusted.
    """
    body = id_token.split(".")[1]
    body += "=" * (-len(body) % 4)
    return json.loads(base64.urlsafe_b64decode(body))


async def _discover(provider: Provider) -> dict:
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.get(provider.server_metadata_url)
        r.raise_for_status()
        return r.json()


@router.get("/providers")
def list_providers() -> dict:
    """What the login UI should offer. Each entry is absent until configured.

    The email link is listed alongside the OIDC providers, with `kind` telling
    the UI how to present it: the others are a button that navigates away, this
    one needs an address typed first. Listing it here rather than hard-coding it
    in the page means the login surface is driven by what the server can
    actually do, so an unconfigured mailer shows no field instead of a field
    that fails.
    """
    out = [
        {"name": p.name, "label": p.label, "kind": "oidc",
         "start": f"/auth/{p.name}/start"}
        for p in enabled_providers()
    ]
    if mail.configured():
        out.append({
            "name": "email", "label": "Email", "kind": "email",
            "start": "/auth/email/request",
        })
    return {"providers": out}


# ─────────────────────────── email link ────────────────────────────

class EmailLinkRequest(BaseModel):
    email: EmailStr
    next: str = "/"


@router.post("/email/request")
def email_link_request(
    body: EmailLinkRequest,
    request: Request,
    db: DbSession = Depends(get_session),
) -> dict:
    """Send a sign-in link, if there is an account for that address.

    **The answer is the same either way.** Known, unknown, invited but never
    signed in, or a non-human account: all return `{"ok": true}` with the same
    message. Saying "no such account" here would hand anyone a way to ask
    whether a given person is a Noctua client, one address at a time.

    The cost of that choice is a real support question — "I asked and nothing
    came" can mean the address has no access yet — and it is paid in the copy,
    which tells the person to check the address with whoever granted it.
    """
    if not mail.configured():
        raise HTTPException(503, "email sign-in is not configured on this service")

    next_path = _safe_next(body.next)
    token = email_link.issue(
        db,
        str(body.email),
        next_path,
        ip=(request.headers.get("x-forwarded-for", "").split(",")[0].strip() or None),
        user_agent=request.headers.get("user-agent"),
    )
    if token is not None:
        link = str(request.base_url).rstrip("/") + "/auth/email/verify?token=" + token
        try:
            mail.send(str(body.email), *_link_message(link))
        except Exception as exc:
            # The token is useless without the mail, so do not leave it behind.
            db.rollback()
            raise HTTPException(503, "could not send the email") from exc
    db.commit()
    # Deliberately identical in both branches.
    return {"ok": True}


def _link_message(link: str) -> tuple[str, str, str]:
    subject = "Seu acesso à Noctua / Your Noctua sign-in link"
    text = (
        "Clique para entrar na Noctua:\n\n"
        f"{link}\n\n"
        "O link vale por 15 minutos e só pode ser usado uma vez.\n"
        "Se não foi você que pediu, ignore esta mensagem.\n\n"
        "— — —\n\n"
        "Click to sign in to Noctua:\n\n"
        f"{link}\n\n"
        "The link is valid for 15 minutes and can be used once.\n"
        "If you did not request it, ignore this message.\n"
    )
    # Inline styles and a table-free layout: this has to render in Outlook too,
    # and a stylesheet would be stripped.
    html = f"""<!DOCTYPE html>
<html><body style="margin:0;padding:24px;background:#111111;font-family:Helvetica,Arial,sans-serif">
  <div style="max-width:440px;margin:0 auto;background:#1a1a1a;border-radius:12px;padding:32px;color:#f0f0f0">
    <div style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:#ff6600;margin-bottom:18px">Noctua</div>
    <div style="font-size:19px;font-weight:800;margin-bottom:10px">Entrar na Noctua</div>
    <div style="font-size:14px;line-height:1.6;color:#888888;margin-bottom:24px">
      O link abaixo vale por 15 minutos e só pode ser usado uma vez.
    </div>
    <a href="{link}" style="display:inline-block;background:#ff6600;color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:8px">Entrar</a>
    <div style="font-size:12px;line-height:1.6;color:#666666;margin-top:26px">
      Se não foi você que pediu, ignore esta mensagem.<br>
      <span style="color:#555555">The link is valid for 15 minutes and can be used once. If you did not request it, ignore this message.</span>
    </div>
  </div>
</body></html>"""
    return subject, text, html


@router.get("/email/verify")
def email_link_verify(
    token: str,
    request: Request,
    response: Response,
    db: DbSession = Depends(get_session),
):
    """Redeem the link and sign in.

    A GET that changes state, which is unavoidable: the thing being clicked is
    a URL in an email client. The token is single-use and consumed inside this
    transaction, so a preview fetch by a mail scanner costs the person their
    link — which is why the failure page says *why* and offers another.
    """
    try:
        user, next_path = email_link.redeem(db, token)
    except email_link.Rejected as rejected:
        db.rollback()
        return _link_failed(rejected)
    sessions.issue(db, user, request, response)
    db.commit()
    redirect = RedirectResponse(_safe_next(next_path), status_code=303)
    # The cookie was set on `response`, which this redirect replaces.
    redirect.raw_headers.extend(
        (k, v) for k, v in response.raw_headers if k.lower() == b"set-cookie"
    )
    return redirect


def _link_failed(rejected: "email_link.Rejected") -> HTMLResponse:
    pt = {
        "invalid": "Este link não é válido.",
        "used": "Este link já foi usado.",
        "expired": "Este link expirou.",
        "gone": "A conta deste link não existe mais.",
    }[rejected.reason]
    body = f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Noctua</title>
<link rel="icon" type="image/png" href="/marca/logo-laranja-circulo.png">
<link rel="stylesheet" href="/admin-hub.css"><link rel="stylesheet" href="/legal.css">
</head><body><main><div class="sect-tag">Login</div>
<h1 class="sect-h">Link <em>inválido</em>.</h1>
<article class="legal"><p>{pt}</p>
<p>Peça um novo em <a href="/assets/">/assets/</a>. Cada link vale por 15 minutos
e só pode ser usado uma vez.</p>
<p style="color:var(--tx3);font-size:12.5px">{rejected.message}
Request a new link from <a href="/assets/">/assets/</a>.</p>
</article></main></body></html>"""
    return HTMLResponse(body, status_code=400, headers={"Cache-Control": "no-store"})


@router.get("/me")
def me(
    user: Optional[User] = Depends(optional_user), db: DbSession = Depends(get_session)
) -> dict:
    if user is None:
        return {"authenticated": False, "user": None}
    orgs = db.execute(
        select(Org.slug, Org.name, Membership.role)
        .join(Membership, Membership.org_id == Org.id)
        .where(Membership.user_id == user.id)
    ).all()
    return {
        "authenticated": True,
        "user": {
            "email": user.email,
            "name": user.name,
            "avatar_url": user.avatar_url,
            "role": user.role,
            "kind": user.kind,
        },
        "orgs": [{"slug": s, "name": n, "role": r} for s, n, r in orgs],
    }


@router.post("/logout")
def logout(request: Request, response: Response, db: DbSession = Depends(get_session)) -> dict:
    revoked = sessions.revoke(db, request, response)
    return {"ok": True, "revoked": revoked}


@router.post("/logout-everywhere")
def logout_everywhere(
    request: Request,
    response: Response,
    user: User = Depends(require_user),
    db: DbSession = Depends(get_session),
) -> dict:
    count = sessions.revoke_all(db, user)
    response.delete_cookie(sessions.COOKIE_NAME, path="/")
    return {"ok": True, "revoked": count}


@router.get("/{provider}/start")
async def oauth_start(provider: str, request: Request, next: str = "/") -> RedirectResponse:
    p = _provider_or_404(provider)
    state = secrets.token_urlsafe(24)
    params = {
        "client_id": p.client_id,
        "redirect_uri": _redirect_uri(request, provider),
        "response_type": "code",
        "scope": p.scope,
        "state": state,
    }
    meta = await _discover(p)
    authorize = meta["authorization_endpoint"]
    params["prompt"] = "select_account"

    resp = RedirectResponse(f"{authorize}?{urlencode(params)}")
    # State and destination ride in a short-lived cookie rather than server
    # storage: it is a handshake, not a session, and this keeps the callback
    # stateless. Verified against the query parameter on the way back.
    resp.set_cookie(
        STATE_COOKIE,
        f"{state}|{_safe_next(next)}",
        max_age=600,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )
    return resp


@router.get("/{provider}/callback", name="oauth_callback")
async def oauth_callback(
    provider: str,
    request: Request,
    db: DbSession = Depends(get_session),
    code: Optional[str] = None,
    state: Optional[str] = None,
    error: Optional[str] = None,
) -> RedirectResponse:
    p = _provider_or_404(provider)
    if error:
        raise HTTPException(400, f"{provider} returned '{error}'")
    if not code or not state:
        raise HTTPException(400, "missing code or state")

    raw = request.cookies.get(STATE_COOKIE) or ""
    expected, _, next_path = raw.partition("|")
    if not expected or not secrets.compare_digest(expected, state):
        raise HTTPException(400, "state mismatch — restart the sign-in")

    claims = await _exchange(p, code, _redirect_uri(request, provider))
    info = p.normalise(claims)
    if not info.get("sub"):
        raise HTTPException(400, f"{provider} did not identify the account")

    user = _match_or_create(db, p, info)
    resp = RedirectResponse(_safe_next(next_path))
    resp.delete_cookie(STATE_COOKIE, path="/")
    sessions.issue(db, user, request, resp)
    db.commit()
    return resp


async def _exchange(p: Provider, code: str, redirect_uri: str) -> dict:
    data = {
        "client_id": p.client_id,
        "client_secret": p.client_secret,
        "code": code,
        "redirect_uri": redirect_uri,
        "grant_type": "authorization_code",
    }
    async with httpx.AsyncClient(timeout=20) as client:
        meta = await _discover(p)
        r = await client.post(meta["token_endpoint"], data=data)
        r.raise_for_status()
        payload = r.json()
        id_token = payload.get("id_token")
        if not id_token:
            raise HTTPException(400, f"{p.name} did not return an id_token")
        return _id_token_claims(id_token)


def _match_or_create(db: DbSession, p: Provider, info: dict) -> User:
    identity = db.scalar(
        select(Identity).where(
            Identity.provider == p.name, Identity.provider_sub == info["sub"]
        )
    )
    if identity:
        user = db.get(User, identity.user_id)
        _refresh_profile(user, info)
        db.flush()
        return user

    user = None
    if info.get("email") and info.get("email_verified"):
        user = db.scalar(select(User).where(User.email == info["email"]))
        if user is not None and user.kind != "human":
            # Never attach a login to the detector or a service account.
            raise HTTPException(403, "that address belongs to a non-human account")

    if user is None:
        if not info.get("email"):
            raise HTTPException(400, f"{p.name} did not supply an email address")
        user = User(
            email=info["email"],
            name=info.get("name"),
            avatar_url=info.get("avatar_url"),
            kind="human",
            role="normal",
        )
        db.add(user)
        db.flush()
    else:
        _refresh_profile(user, info)

    db.add(
        Identity(
            user_id=user.id,
            provider=p.name,
            provider_sub=info["sub"],
            email=info.get("email"),
        )
    )
    db.flush()
    return user


def _refresh_profile(user: User, info: dict) -> None:
    if not user.name and info.get("name"):
        user.name = info["name"]
    if info.get("avatar_url"):
        user.avatar_url = info["avatar_url"]
    user.last_seen_at = datetime.now(timezone.utc)
