"""Turning the site's JSON shape into rows.

Both the one-off importer and the write API come through here. The write path
could have parsed its own payloads — they are the same shape — and that is
exactly the trap: two parsers for `"0,004 m²"`, two opinions on whether a point
belongs to a tile, and a slow drift between what an import produces and what a
save produces. One module, one answer.
"""
from __future__ import annotations

import re
from datetime import date, datetime
from pathlib import Path
from typing import Any, Iterable, Optional

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from api.models import (
    Annotation,
    Anomaly,
    AnomalyTag,
    Asset,
    Evaluation,
    Image,
    Inspection,
    Model3D,
    Photo,
    User,
)

DEFAULT_BUCKET = "noctua-models"
EMPTY = {"", "—", "-", "–", "n/a", "N/A", "None", None}


class Counter:
    """Tallies what an ingest touched. The importer prints it; the API ignores it."""

    def __init__(self) -> None:
        self.data: dict[str, int] = {}

    def bump(self, key: str, n: int = 1) -> None:
        self.data[key] = self.data.get(key, 0) + n


def fnum(v: Any) -> Optional[float]:
    """'0.004 m²' -> 0.004 ; '—' -> None ; '-8.5189' -> -8.5189"""
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if s in EMPTY:
        return None
    m = re.search(r"-?\d+(?:[.,]\d+)?", s.replace(",", "."))
    return float(m.group()) if m else None


def ftext(v: Any) -> Optional[str]:
    if v is None:
        return None
    s = str(v).strip()
    return None if s in EMPTY else s


def fdate(v: Any) -> Optional[date]:
    s = ftext(v)
    if not s:
        return None
    try:
        return date.fromisoformat(s[:10])
    except ValueError:
        return None


def fdatetime(v: Any) -> Optional[datetime]:
    s = ftext(v)
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _visibility(j: dict) -> str:
    """Legacy `requireLogin` maps to `link`, never to `private`.

    The old gate asked for a Google sign-in and then accepted ANY account — it
    recorded who looked, it did not decide who may. What actually protected an
    inspection was the unguessable slug. So the faithful translation is `link`
    (holding the URL is the capability), and `private` is a new, stronger tier
    that nothing has yet. Mapping these to `private` would have revoked every
    link already delivered to a client.
    """
    return "public" if j.get("requireLogin") is False else "link"


def sha_of(url: str) -> Optional[str]:
    """The site stores blobs as img/<sha256>.<ext>; recover the hash from the URL."""
    stem = Path(url.split("?")[0]).stem
    return stem if re.fullmatch(r"[0-9a-f]{64}", stem) else None


def split_location(url: str) -> tuple[Optional[str], str]:
    """(bucket, object_path). A NULL bucket means a site-local path.

    Recognises both buckets, because a payload can carry a URL this service
    itself emitted a moment earlier — including a signed one, whose query has
    to be dropped or it would become part of the stored object path.
    """
    from api import storage

    for bucket in (storage.PUBLIC_BUCKET, storage.PRIVATE_BUCKET):
        if not bucket:
            continue
        marker = f"/{bucket}/"
        if marker in url:
            return bucket, url.split(marker, 1)[1].split("?", 1)[0]
    # Kept verbatim: a leading slash, or the absence of one, is part of the value.
    return None, url


def point_in_poly(x: float, y: float, poly: Iterable[dict]) -> bool:
    """Ray casting. Polygon vertices are {nx, ny}, normalised inside the tile."""
    pts = [(float(p["nx"]), float(p["ny"])) for p in poly if "nx" in p and "ny" in p]
    if len(pts) < 3:
        return False
    inside = False
    j = len(pts) - 1
    for i in range(len(pts)):
        xi, yi = pts[i]
        xj, yj = pts[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / ((yj - yi) or 1e-12) + xi:
            inside = not inside
        j = i
    return inside


# ──────────────────────────────── importer ──────────────────────────────────

def ensure_image(db: Session, url: Optional[str],
                 count: Optional[Counter] = None) -> Optional[Image]:
    url = ftext(url)
    if not url:
        return None
    sha = sha_of(url)
    bucket, path = split_location(url)
    key = sha or path
    img = db.scalar(select(Image).where(Image.sha256 == key))
    if not img:
        img = Image(sha256=key, bucket=bucket, object_path=path)
        db.add(img)
        db.flush()
        if count:
            count.bump("images")
    return img

def ensure_model(db: Session, asset_json: dict, actor: User,
                 count: Optional[Counter] = None) -> Optional[Model3D]:
    url = ftext(asset_json.get("model"))
    if not url:
        return None
    bucket, path = split_location(url)
    m = db.scalar(select(Model3D).where(Model3D.object_path == path))
    if not m:
        kind = "splat" if (asset_json.get("kind") == "splat"
                           or path.lower().endswith((".splat", ".ply", ".ksplat", ".sog"))) else "glb"
        m = Model3D(
            sha256=sha_of(url),
            bucket=bucket,
            object_path=path,
            kind=kind,
            rotation=asset_json.get("modelRotation"),
            offset=asset_json.get("modelOffset"),
            scale=fnum(asset_json.get("modelScale")),
            created_by=actor.id,
        )
        db.add(m)
        db.flush()
        if count:
            count.bump("models3d")
    return m

# -- assets --------------------------------------------------------------

def wipe_inspection_children(db: Session, insp: Inspection) -> None:
    """Rebuild derived rows from scratch; the JSON file is still the truth."""
    anomaly_ids = list(db.scalars(select(Anomaly.id).where(Anomaly.inspection_id == insp.id)))
    photo_ids = list(db.scalars(select(Photo.id).where(Photo.inspection_id == insp.id)))
    if anomaly_ids:
        # Break the anomaly -> evaluation cycle before deleting either side.
        db.execute(update(Anomaly).where(Anomaly.id.in_(anomaly_ids))
                       .values(current_evaluation_id=None))
    if photo_ids:
        db.execute(delete(Annotation).where(Annotation.photo_id.in_(photo_ids)))
    if anomaly_ids:
        db.execute(delete(Evaluation).where(Evaluation.anomaly_id.in_(anomaly_ids)))
        db.execute(delete(AnomalyTag).where(AnomalyTag.anomaly_id.in_(anomaly_ids)))
        db.execute(delete(Anomaly).where(Anomaly.id.in_(anomaly_ids)))
    db.execute(delete(Photo).where(Photo.inspection_id == insp.id))
    db.flush()

def ingest_photos(db: Session, insp: Inspection, raw: list[dict], count: Counter) -> list[tuple[Photo, dict]]:
    out = []
    for ph in raw:
        img = ensure_image(db, ph.get("url"), count)
        if not img:
            warnings.append(f"inspection {insp.slug}: foto sem url — pulada")
            continue
        tile = ph.get("source") or {}
        is_tile = tile.get("kind") == "ortho"
        exif = ph.get("exif") or {}
        p = Photo(
            inspection_id=insp.id,
            image_id=img.id,
            kind="ortho_tile" if is_tile else "photo",
            name=ftext(ph.get("name")),
            taken_at=fdatetime(exif.get("timestamp")),
            source="ortho" if is_tile else None,
            heading=fnum(exif.get("heading")),
            tile=tile or None,
            verdict=ph.get("verdict") if ph.get("verdict") in ("clean", "has_defects") else "pending",
        )
        db.add(p)
        count.bump("photos")
        out.append((p, ph))
    db.flush()
    return out

def ingest_anomalies(db: Session, insp: Inspection, raw: list[dict], actor: User, count: Counter) -> list[tuple[Anomaly, dict]]:
    out = []
    for pt in raw:
        pos = pt.get("position") or {}
        src = pt.get("source") or {}
        crop = ensure_image(db, pt.get("image"), count)
        a = Anomaly(
            inspection_id=insp.id,
            ext_id=ftext(pt.get("id")),
            px=fnum(pos.get("x")),
            py=fnum(pos.get("y")),
            pz=fnum(pos.get("z")),
            location=ftext(pt.get("location")),
            source_kind=ftext(src.get("kind")),
            source_name=ftext(src.get("name")),
            source_nx=fnum(src.get("nx")),
            source_ny=fnum(src.get("ny")),
            crop_image_id=crop.id if crop else None,
            created_by=actor.id,
        )
        db.add(a)
        db.flush()
        count.bump("anomalies")

        sev = ftext(pt.get("severity"))
        ev = Evaluation(
            anomaly_id=a.id,
            problem=ftext(pt.get("type")),
            suggested_fix=ftext(pt.get("action")),
            criticality=sev if sev in ("low", "medium", "high", "critical") else None,
            score=fnum(pt.get("score")),
            area_m2=fnum(pt.get("area")),
            depth_m=fnum(pt.get("depth")),
            detected_on=fdate(pt.get("detected")),
            # Hand-made by an operator, so already reviewed by definition.
            author_id=actor.id,
            status="approved",
            reviewed_by=actor.id,
            reviewed_at=insp.evaluated_at or insp.captured_at,
        )
        db.add(ev)
        db.flush()
        a.current_evaluation_id = ev.id
        count.bump("evaluations")

        # `type` is not folded in here: it is the evaluation's `problem`.
        # Folding it would invent a tag the original list never had.
        seen = set()
        for pos, t in enumerate(pt.get("tags") or []):
            t = ftext(t)
            if not t or t in seen:
                continue
            seen.add(t)
            db.add(AnomalyTag(anomaly_id=a.id, tag=t, position=pos))
            count.bump("anomaly_tags")
        out.append((a, pt))
    db.flush()
    return out

def ingest_annotations(db: Session, insp, photos, anomalies, actor: User, count: Counter, warnings: list) -> None:
    """Each legacy `defect` polygon becomes an annotation.

    Linking it back to an anomaly uses geometry, not ordering: the anomaly's
    (nx, ny) in the ortho is converted to tile-relative coordinates and tested
    against the polygon. Counts per tile do not match (some tiles hold a point
    with no defect), so pairing by index would silently mispair.
    """
    for photo, ph in photos:
        tile = ph.get("source") or {}
        try:
            x0, y0, x1, y1 = (float(tile[k]) for k in ("x0", "y0", "x1", "y1"))
        except (KeyError, TypeError, ValueError):
            x0 = y0 = x1 = y1 = None
        for df in ph.get("defects") or []:
            poly = df.get("poly") or []
            match = None
            if x0 is not None and x1 != x0 and y1 != y0:
                for a, pt in anomalies:
                    src = pt.get("source") or {}
                    nx, ny = fnum(src.get("nx")), fnum(src.get("ny"))
                    if nx is None or ny is None:
                        continue
                    if point_in_poly((nx - x0) / (x1 - x0), (ny - y0) / (y1 - y0), poly):
                        match = a
                        break
            sev = ftext(df.get("sev"))
            db.add(Annotation(
                photo_id=photo.id,
                anomaly_id=match.id if match else None,
                region={"type": "polygon", "points": poly},
                label=(df.get("tags") or [None])[0],
                author_id=actor.id,
                status="approved",
                reviewed_by=actor.id,
            ))
            count.bump("annotations")
            if match:
                count.bump("annotations_linked")
            else:
                count.bump("annotations_orphan")
                warnings.append(
                    f"inspection {insp.slug}: defeito em '{photo.name}' "
                    f"(sev={sev}) sem anomalia correspondente"
                )
    db.flush()

# -- assets with a model but no inspection -------------------------------


# ───────────────────────── upserts ──────────────────────────
# The unit of work is a whole asset or a whole inspection, because that is what
# the editor has in hand: it holds the complete object and saves it. Patching
# individual points would be a different editor, not a different endpoint.

def upsert_asset(db: Session, slug: str, payload: dict, actor: User, *,
                 count: Optional[Counter] = None) -> Asset:
    count = count or Counter()
    model = ensure_model(db, payload, actor, count)
    thumb = ensure_image(db, payload.get("thumbnail"), count)
    a = db.scalar(select(Asset).where(Asset.slug == slug))
    if a is None:
        a = Asset(slug=slug)
        db.add(a)
        count.bump("assets")
    a.name = ftext(payload.get("name")) or slug
    a.visibility = _visibility(payload)
    if thumb is not None:
        a.thumbnail_id = thumb.id
    a.og_title = ftext(payload.get("name")) or slug
    if a.created_by is None:
        a.created_by = actor.id
    created_at = fdatetime(payload.get("createdAt"))
    if created_at:
        a.created_at = created_at
    db.flush()
    return a


def upsert_inspection(db: Session, slug: str, payload: dict, actor: User, *,
                      count: Optional[Counter] = None,
                      warnings: Optional[list] = None,
                      fallback_model: Optional[Model3D] = None) -> Inspection:
    """Replace an inspection and everything hanging off it.

    Children are wiped and rebuilt rather than diffed. The payload is the whole
    truth from the editor, and a diff would have to guess which of two points
    with the same coordinates is 'the same point' — a guess that silently moves
    an anomaly's history onto the wrong defect.
    """
    count = count or Counter()
    warnings = warnings if warnings is not None else []

    asset_slug = payload.get("asset")
    asset = db.scalar(select(Asset).where(Asset.slug == asset_slug)) if asset_slug else None
    if asset is None:
        raise ValueError(f"asset '{asset_slug}' does not exist")

    # Three sources, in order: the payload's own model, the newest model already
    # on this asset, and a model handed in by the caller. The third is not
    # redundant — the asset's first inspection has nothing to join through, so
    # on an import (or a brand-new asset) the join is empty by construction.
    model = (
        ensure_model(db, payload, actor, count)
        or db.scalar(
            select(Model3D)
            .join(Inspection, Inspection.model_id == Model3D.id)
            .where(Inspection.asset_id == asset.id)
            .order_by(Inspection.captured_at.desc().nullslast())
            .limit(1)
        )
        or fallback_model
    )
    if model is None:
        raise ValueError("no 3D model: neither the payload nor the asset has one")

    insp = db.scalar(select(Inspection).where(Inspection.slug == slug))
    if insp is None:
        insp = Inspection(slug=slug)
        db.add(insp)
        count.bump("inspections")
    insp.asset_id = asset.id
    insp.model_id = model.id
    insp.captured_at = fdatetime(payload.get("date"))
    insp.evaluated_at = fdatetime(payload.get("evaluatedAt"))
    if insp.inspector_id is None:
        insp.inspector_id = actor.id
    if insp.created_by is None:
        insp.created_by = actor.id
    insp.status = "published"
    # Same inheritance rule the importer uses: `requireLogin` lives on the
    # asset, so an inspection that does not state its own follows the asset.
    insp.visibility = _visibility(payload) if "requireLogin" in payload else asset.visibility
    insp.og_title = ftext(payload.get("project")) or asset.name
    db.flush()

    wipe_inspection_children(db, insp)
    photos = ingest_photos(db, insp, payload.get("evalPhotos") or [], count)
    anomalies = ingest_anomalies(db, insp, payload.get("points") or [], actor, count)
    ingest_annotations(db, insp, photos, anomalies, actor, count, warnings)
    return insp
