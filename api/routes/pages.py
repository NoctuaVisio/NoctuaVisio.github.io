"""Share pages rendered from the database.

These replace `inspection/<slug>/index.html` and `asset/<slug>/index.html`,
which were HTML files COMMITTED to the repository for one reason: a crawler
fetching a link needs real meta tags in the first response, and GitHub Pages
cannot produce them. That was the only thing keeping the generator alive, so it
has to exist here before the commit path can be deleted.

The body is the same handoff the generated files did — stash the route, bounce
to the SPA — so behaviour for a human is unchanged while a crawler, which runs
no script, gets the tags it came for.
"""
from __future__ import annotations

import html
import json
from typing import Optional

from fastapi import APIRouter, Depends, Request
from fastapi.responses import HTMLResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from api.auth.deps import optional_user
from api.db import get_session
from api.models import Asset, Image, Inspection, User
from api.routes.legacy import url_of

router = APIRouter(tags=["pages"])

DESCRIPTION = "Interactive 3D asset — Noctua"


def _page(*, title: str, description: str, image: Optional[str], url: str,
          route: dict, target: str) -> HTMLResponse:
    e = html.escape
    img_tags = ""
    if image:
        img_tags = (
            f'<meta property="og:image" content="{e(image)}">\n'
            f'<meta name="twitter:image" content="{e(image)}">\n'
        )
    body = f"""<!DOCTYPE html>
<html lang="pt-BR"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{e(title)} — Noctua</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="Noctua">
<meta property="og:title" content="{e(title)}">
<meta property="og:description" content="{e(description)}">
<meta property="og:url" content="{e(url)}">
{img_tags}<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="{e(title)}">
<link rel="icon" type="image/png" href="/marca/logo-laranja-circulo.png">
<script>try{{sessionStorage.setItem('noctua_route',{json.dumps(json.dumps(route))});}}catch(e){{}}location.replace({json.dumps(target)});</script>
</head><body style="background:#111;color:#eee;font-family:Inter,system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0">
Loading…
</body></html>"""
    # no-store: the tags come from the database, and a cached copy would outlive
    # a rename or a thumbnail change.
    return HTMLResponse(body, headers={"Cache-Control": "no-store"})


def _thumb_url(db: Session, image_id) -> Optional[str]:
    if not image_id:
        return None
    img = db.get(Image, image_id)
    return url_of(img.bucket, img.object_path) if img else None


@router.get("/asset/{slug}", response_class=HTMLResponse)
def asset_page(
    slug: str, request: Request, db: Session = Depends(get_session),
    user: Optional[User] = Depends(optional_user),
) -> HTMLResponse:
    a = db.scalar(select(Asset).where(Asset.slug == slug))
    if a is None:
        return _page(title="Noctua", description=DESCRIPTION, image=None,
                     url=str(request.url), route={"page": "asset", "slug": slug},
                     target="/asset/")
    return _page(
        title=a.og_title or a.name,
        description=a.og_description or DESCRIPTION,
        image=_thumb_url(db, a.thumbnail_id),
        url=str(request.url),
        route={"page": "asset", "slug": slug},
        target="/asset/",
    )


@router.get("/inspection/{slug}", response_class=HTMLResponse)
def inspection_page(
    slug: str, request: Request, db: Session = Depends(get_session),
    user: Optional[User] = Depends(optional_user),
) -> HTMLResponse:
    i = db.scalar(select(Inspection).where(Inspection.slug == slug))
    if i is None:
        return _page(title="Noctua", description=DESCRIPTION, image=None,
                     url=str(request.url),
                     route={"page": "inspection", "slug": slug},
                     target=f"/inspection/?slug={slug}")
    asset = db.get(Asset, i.asset_id)
    # The thumbnail is rendered regardless of visibility, exactly as the
    # committed pages did: it is the preview of a link whose holder already has
    # the URL. The model behind it is what visibility protects.
    return _page(
        title=i.og_title or (asset.name if asset else slug),
        description=i.og_description or DESCRIPTION,
        image=_thumb_url(db, i.thumbnail_id) or (
            _thumb_url(db, asset.thumbnail_id) if asset else None
        ),
        url=str(request.url),
        route={"page": "inspection", "slug": slug},
        target=f"/inspection/?slug={slug}",
    )
