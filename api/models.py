"""Relational model for Noctua.

Shape follows migration-plan.md §3. Two conventions worth stating once:

* Enum-ish columns are TEXT with a CHECK constraint, not native PG enums.
  Adding a value to a native enum inside a transaction is a known pain, and this
  schema is young enough that values will keep appearing.
* Anything the AI can produce carries `author_id` (a user row — the detector is a
  user with kind='ai') kept separate from `status` (where it sits in review).
"""
from __future__ import annotations

import uuid
from datetime import date, datetime
from typing import Optional

from sqlalchemy import (
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from api.db import Base


def pk() -> Mapped[uuid.UUID]:
    return mapped_column(
        UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()")
    )


def created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)


def one_of(column: str, *values: str) -> CheckConstraint:
    allowed = ", ".join(f"'{v}'" for v in values)
    return CheckConstraint(f"{column} IN ({allowed})", name=f"ck_{column}")


# ─────────────────────────────── identity ───────────────────────────────

class User(Base):
    __tablename__ = "users"
    id: Mapped[uuid.UUID] = pk()
    # Stored lowercased by the application; plain text keeps us off the citext
    # extension for a constraint we can enforce ourselves.
    email: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    name: Mapped[Optional[str]] = mapped_column(Text)
    avatar_url: Mapped[Optional[str]] = mapped_column(Text)
    # kind='ai' users never get an `identities` row, which is what actually makes
    # logging in as them impossible — not a check scattered through the code.
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="human")
    role: Mapped[str] = mapped_column(Text, nullable=False, server_default="normal")
    created_at: Mapped[datetime] = created()
    last_seen_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        one_of("kind", "human", "ai", "service"),
        one_of("role", "admin", "normal"),
    )


class Identity(Base):
    __tablename__ = "identities"
    id: Mapped[uuid.UUID] = pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False)
    provider_sub: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[Optional[str]] = mapped_column(Text)
    created_at: Mapped[datetime] = created()
    __table_args__ = (
        UniqueConstraint("provider", "provider_sub", name="uq_identity_provider_sub"),
        one_of("provider", "google", "github", "microsoft", "email"),
    )


class Session(Base):
    """A logged-in browser.

    The cookie carries a random token; only its SHA-256 lands here. A dump of
    this table therefore cannot be replayed as a login, which a table of raw
    tokens would allow.
    """

    __tablename__ = "sessions"
    id: Mapped[uuid.UUID] = pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    created_at: Mapped[datetime] = created()
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    user_agent: Mapped[Optional[str]] = mapped_column(Text)
    ip: Mapped[Optional[str]] = mapped_column(Text)
    __table_args__ = (Index("ix_sessions_user", "user_id"),)


class Org(Base):
    __tablename__ = "orgs"
    id: Mapped[uuid.UUID] = pk()
    slug: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created()


class Membership(Base):
    __tablename__ = "memberships"
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("orgs.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(Text, nullable=False, server_default="member")
    invited_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    joined_at: Mapped[datetime] = created()
    __table_args__ = (one_of("role", "owner", "member"),)


# ──────────────────────────────── blobs ─────────────────────────────────

class Image(Base):
    __tablename__ = "images"
    id: Mapped[uuid.UUID] = pk()
    # The join key with Label Studio: same GCS object referenced from both sides.
    sha256: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    # NULL bucket means a site-local path (/models/x.glb), not a GCS object.
    bucket: Mapped[Optional[str]] = mapped_column(Text)
    object_path: Mapped[str] = mapped_column(Text, nullable=False)
    mime: Mapped[Optional[str]] = mapped_column(Text)
    width: Mapped[Optional[int]] = mapped_column(Integer)
    height: Mapped[Optional[int]] = mapped_column(Integer)
    bytes: Mapped[Optional[int]] = mapped_column(Integer)
    created_at: Mapped[datetime] = created()


class Model3D(Base):
    __tablename__ = "models3d"
    id: Mapped[uuid.UUID] = pk()
    sha256: Mapped[Optional[str]] = mapped_column(Text, unique=True)
    bucket: Mapped[Optional[str]] = mapped_column(Text)
    object_path: Mapped[str] = mapped_column(Text, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="glb")
    bytes: Mapped[Optional[int]] = mapped_column(Integer)
    rotation: Mapped[Optional[dict]] = mapped_column(JSONB)
    offset: Mapped[Optional[dict]] = mapped_column(JSONB)
    scale: Mapped[Optional[float]] = mapped_column(Numeric)
    created_at: Mapped[datetime] = created()
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    __table_args__ = (one_of("kind", "glb", "splat"),)


# ─────────────────────────────── domain ─────────────────────────────────

class Asset(Base):
    __tablename__ = "assets"
    id: Mapped[uuid.UUID] = pk()
    owner_org_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("orgs.id"))
    slug: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text)
    lat: Mapped[Optional[float]] = mapped_column(Numeric)
    lon: Mapped[Optional[float]] = mapped_column(Numeric)
    address: Mapped[Optional[str]] = mapped_column(Text)
    # No model here on purpose: the asset page renders the latest inspection's scan.
    thumbnail_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("images.id"))
    og_title: Mapped[Optional[str]] = mapped_column(Text)
    og_description: Mapped[Optional[str]] = mapped_column(Text)
    visibility: Mapped[str] = mapped_column(Text, nullable=False, server_default="private")
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = created()
    __table_args__ = (one_of("visibility", "public", "link", "private"),)


class AssetOrgAccess(Base):
    __tablename__ = "asset_org_access"
    asset_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("assets.id", ondelete="CASCADE"), primary_key=True
    )
    org_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("orgs.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(Text, nullable=False, server_default="viewer")
    granted_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    granted_at: Mapped[datetime] = created()
    __table_args__ = (one_of("role", "editor", "labeler", "viewer"),)


class AssetUserAccess(Base):
    __tablename__ = "asset_user_access"
    asset_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("assets.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(Text, nullable=False, server_default="viewer")
    granted_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    granted_at: Mapped[datetime] = created()
    __table_args__ = (one_of("role", "editor", "labeler", "viewer"),)


class Inspection(Base):
    __tablename__ = "inspections"
    id: Mapped[uuid.UUID] = pk()
    asset_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("assets.id", ondelete="CASCADE"), nullable=False
    )
    slug: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    captured_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    inspector_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    # Every flight is its own scan. Required.
    model_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("models3d.id"), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="draft")
    evaluated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    thumbnail_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("images.id"))
    og_title: Mapped[Optional[str]] = mapped_column(Text)
    og_description: Mapped[Optional[str]] = mapped_column(Text)
    visibility: Mapped[str] = mapped_column(Text, nullable=False, server_default="private")
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = created()
    __table_args__ = (
        one_of("status", "draft", "evaluating", "published"),
        one_of("visibility", "public", "link", "private"),
        Index("ix_inspections_asset", "asset_id"),
    )


class Photo(Base):
    __tablename__ = "photos"
    id: Mapped[uuid.UUID] = pk()
    inspection_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("inspections.id", ondelete="CASCADE"), nullable=False
    )
    image_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("images.id"), nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False, server_default="photo")
    name: Mapped[Optional[str]] = mapped_column(Text)
    taken_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    # How the image was obtained — not to be confused with `tile`, which is the
    # crop geometry the old JSON confusingly also called "source".
    source: Mapped[Optional[str]] = mapped_column(Text)
    device: Mapped[Optional[str]] = mapped_column(Text)
    lat: Mapped[Optional[float]] = mapped_column(Numeric)
    lon: Mapped[Optional[float]] = mapped_column(Numeric)
    altitude: Mapped[Optional[float]] = mapped_column(Numeric)
    heading: Mapped[Optional[float]] = mapped_column(Numeric)
    tile: Mapped[Optional[dict]] = mapped_column(JSONB)
    verdict: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    ls_task_id: Mapped[Optional[int]] = mapped_column(Integer)
    created_at: Mapped[datetime] = created()
    __table_args__ = (
        one_of("kind", "photo", "ortho_tile"),
        one_of("source", "drone", "handheld", "ortho", "other"),
        one_of("verdict", "pending", "clean", "has_defects"),
        Index("ix_photos_inspection", "inspection_id"),
    )


class Anomaly(Base):
    """Just the identity of a problem: where it sits on the 3D model.

    What is known about it lives in `evaluations`; where it is visible lives in
    `annotations`.
    """

    __tablename__ = "anomalies"
    id: Mapped[uuid.UUID] = pk()
    inspection_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("inspections.id", ondelete="CASCADE"), nullable=False
    )
    ext_id: Mapped[Optional[str]] = mapped_column(Text)
    px: Mapped[Optional[float]] = mapped_column(Numeric)
    py: Mapped[Optional[float]] = mapped_column(Numeric)
    pz: Mapped[Optional[float]] = mapped_column(Numeric)
    location: Mapped[Optional[str]] = mapped_column(Text)
    # Where the anomaly sits on the image it was spotted in: which file, and the
    # normalised (x, y) inside it. Distinct from the tile bbox on `photos` — that
    # is the crop's extent, this is the point itself.
    source_kind: Mapped[Optional[str]] = mapped_column(Text)
    source_name: Mapped[Optional[str]] = mapped_column(Text)
    source_nx: Mapped[Optional[float]] = mapped_column(Numeric)
    source_ny: Mapped[Optional[float]] = mapped_column(Numeric)
    # The crop shown next to the defect in the viewer. Lives here rather than on
    # the annotation because an anomaly can exist with no photo behind it at all
    # (17 of the 41 legacy points are exactly that).
    crop_image_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("images.id"))
    # Read shortcut; the authoritative history is the evaluations rows themselves.
    current_evaluation_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("evaluations.id", use_alter=True, name="fk_anomaly_current_eval")
    )
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        UniqueConstraint("inspection_id", "ext_id", name="uq_anomaly_ext_id"),
        Index("ix_anomalies_inspection", "inspection_id"),
    )


class AnomalyTag(Base):
    __tablename__ = "anomaly_tags"
    anomaly_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("anomalies.id", ondelete="CASCADE"), primary_key=True
    )
    tag: Mapped[str] = mapped_column(Text, primary_key=True)
    # Tags are an ordered list in the UI, not a set.
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")


class Evaluation(Base):
    """The diagnosis, versioned.

    The AI writes a row; the human who corrects it writes another that supersedes
    it. The original is never overwritten — that pair is the training signal.
    """

    __tablename__ = "evaluations"
    id: Mapped[uuid.UUID] = pk()
    anomaly_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("anomalies.id", ondelete="CASCADE"), nullable=False
    )
    problem: Mapped[Optional[str]] = mapped_column(Text)
    suggested_fix: Mapped[Optional[str]] = mapped_column(Text)
    criticality: Mapped[Optional[str]] = mapped_column(Text)
    score: Mapped[Optional[float]] = mapped_column(Numeric)
    area_m2: Mapped[Optional[float]] = mapped_column(Numeric)
    depth_m: Mapped[Optional[float]] = mapped_column(Numeric)
    detected_on: Mapped[Optional[date]] = mapped_column(Date)
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    model_version: Mapped[Optional[str]] = mapped_column(Text)
    confidence: Mapped[Optional[float]] = mapped_column(Numeric)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="draft")
    reviewed_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    supersedes_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("evaluations.id"))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        one_of("criticality", "low", "medium", "high", "critical"),
        one_of("status", "draft", "pending_review", "approved", "rejected", "superseded"),
        Index("ix_evaluations_anomaly", "anomaly_id"),
    )


class Annotation(Base):
    """Where an anomaly is visible on a photo. One row per Label Studio annotation.

    `anomaly_id` is nullable: an AI suggestion nobody accepted yet is not an
    anomaly. Accepting it is what creates one.
    """

    __tablename__ = "annotations"
    id: Mapped[uuid.UUID] = pk()
    photo_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("photos.id", ondelete="CASCADE"), nullable=False
    )
    anomaly_id: Mapped[Optional[uuid.UUID]] = mapped_column(
        ForeignKey("anomalies.id", ondelete="SET NULL")
    )
    region: Mapped[Optional[dict]] = mapped_column(JSONB)
    label: Mapped[Optional[str]] = mapped_column(Text)
    author_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    model_version: Mapped[Optional[str]] = mapped_column(Text)
    confidence: Mapped[Optional[float]] = mapped_column(Numeric)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending_review")
    ls_annotation_id: Mapped[Optional[int]] = mapped_column(Integer, unique=True)
    ls_prediction_id: Mapped[Optional[int]] = mapped_column(Integer)
    ls_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    reviewed_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    reviewed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    supersedes_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("annotations.id"))
    created_at: Mapped[datetime] = created()
    updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    __table_args__ = (
        one_of("status", "pending_review", "approved", "rejected", "superseded"),
        Index("ix_annotations_photo", "photo_id"),
        Index("ix_annotations_anomaly", "anomaly_id"),
    )


# ──────────────────────────────── support ───────────────────────────────

class EvalTask(Base):
    __tablename__ = "eval_tasks"
    id: Mapped[uuid.UUID] = pk()
    legacy_id: Mapped[Optional[str]] = mapped_column(Text, unique=True)
    inspection_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("inspections.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[Optional[str]] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default="pending")
    align: Mapped[Optional[dict]] = mapped_column(JSONB)
    source: Mapped[Optional[dict]] = mapped_column(JSONB)
    ls_project_id: Mapped[Optional[int]] = mapped_column(Integer)
    # Transitional: the legacy task JSON carries admin-side state (cursor,
    # inspectionTransform, appliedAt…) that gets a proper model when the
    # evaluation flow is rebuilt. Kept verbatim so nothing is destroyed.
    payload: Mapped[Optional[dict]] = mapped_column(JSONB)
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = created()
    __table_args__ = (one_of("status", "pending", "running", "done"),)


class Featured(Base):
    """Replaces landing-models.json.

    Keyed by inspection, not asset: the landing carousel renders a model plus its
    points, which is an inspection.
    """

    __tablename__ = "featured"
    inspection_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("inspections.id", ondelete="CASCADE"), primary_key=True
    )
    position: Mapped[int] = mapped_column(Integer, nullable=False)


class LoginToken(Base):
    """A single-use link that signs one address in.

    This is what makes "any account" true: no provider has to exist for an
    address, so a client on a domain that is neither Google nor Microsoft still
    gets in. The address itself is the proof, and the fact that only its owner
    can read the message is the authentication.

    Same discipline as `sessions`: only the SHA-256 of the token is stored, so a
    dump of this table cannot be redeemed. `consumed_at` is what makes it
    single-use, and it is a column rather than a DELETE so a second click gets
    "already used" instead of "invalid", which are different things to the
    person holding the link.
    """

    __tablename__ = "login_tokens"
    id: Mapped[uuid.UUID] = pk()
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    # Where to land after signing in. Validated as a same-site path when the
    # link is requested, not when it is redeemed.
    next_path: Mapped[str] = mapped_column(Text, nullable=False, server_default="/")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created()
    # Who asked, as the request saw them. Not identity — it is the audit trail
    # for "somebody requested a link for this address".
    requested_ip: Mapped[Optional[str]] = mapped_column(Text)
    requested_ua: Mapped[Optional[str]] = mapped_column(Text)
    __table_args__ = (Index("ix_login_tokens_email", "email"),)


class ShareLink(Base):
    __tablename__ = "share_links"
    token: Mapped[str] = mapped_column(Text, primary_key=True)
    inspection_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("inspections.id", ondelete="CASCADE"), nullable=False
    )
    expires_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = created()
    revoked_at: Mapped[Optional[datetime]] = mapped_column(DateTime(timezone=True))


class AuditLog(Base):
    __tablename__ = "audit_log"
    id: Mapped[uuid.UUID] = pk()
    at: Mapped[datetime] = created()
    user_id: Mapped[Optional[uuid.UUID]] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(Text, nullable=False)
    subject_type: Mapped[Optional[str]] = mapped_column(Text)
    subject_id: Mapped[Optional[str]] = mapped_column(Text)
    meta: Mapped[Optional[dict]] = mapped_column(JSONB)
