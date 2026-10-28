"""Social identity providers.

A provider is enabled by having its client id and secret in the environment —
no code change, no redeploy of a different image. `GOOGLE_CLIENT_ID` +
`GOOGLE_CLIENT_SECRET` turns Google on; the same pattern holds for the others.

Every provider here is OpenID Connect, so one code path covers them all:
discover the endpoints, exchange the code, read the id_token claims. The
per-provider work is only in `normalise`, because each spells the user's name
and picture differently.

GitHub was here and was removed on purpose: it is plain OAuth2 with no
discovery and no id_token, so it needed a branch of its own through the token
exchange. Adding it back means restoring that branch, not just a table entry.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Callable, Optional


@dataclass(frozen=True)
class Provider:
    name: str
    label: str
    server_metadata_url: str
    scope: str
    normalise: Callable[[dict], dict]

    @property
    def client_id(self) -> Optional[str]:
        return os.environ.get(f"{self.name.upper()}_CLIENT_ID")

    @property
    def client_secret(self) -> Optional[str]:
        return os.environ.get(f"{self.name.upper()}_CLIENT_SECRET")

    @property
    def enabled(self) -> bool:
        return bool(self.client_id and self.client_secret)


def _google(claims: dict) -> dict:
    return {
        "sub": claims.get("sub"),
        "email": (claims.get("email") or "").lower() or None,
        "email_verified": bool(claims.get("email_verified")),
        "name": claims.get("name"),
        "avatar_url": claims.get("picture"),
    }


def _microsoft(claims: dict) -> dict:
    return {
        "sub": claims.get("sub") or claims.get("oid"),
        "email": (claims.get("email") or claims.get("preferred_username") or "").lower() or None,
        # Microsoft does not send email_verified; a tenant-issued address is
        # verified by the tenant, which is the same assurance we need.
        "email_verified": True,
        "name": claims.get("name"),
        "avatar_url": None,
    }


PROVIDERS: dict[str, Provider] = {
    "google": Provider(
        name="google",
        label="Google",
        server_metadata_url="https://accounts.google.com/.well-known/openid-configuration",
        scope="openid email profile",
        normalise=_google,
    ),
    "microsoft": Provider(
        name="microsoft",
        label="Microsoft",
        server_metadata_url="https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration",
        scope="openid email profile",
        normalise=_microsoft,
    ),
}


def enabled_providers() -> list[Provider]:
    return [p for p in PROVIDERS.values() if p.enabled]
