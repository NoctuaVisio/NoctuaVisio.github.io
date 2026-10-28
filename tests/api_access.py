"""API contracts that need a real database.

One transactional harness, several contracts: who may see what, and which scan
an inspection renders. Kept in one file because the fixtures and the rollback
are the same; two files would mean two copies of them.

## Who may see what

The reported failure was that a person granted an asset could not see it. The
grant was in the table and the API honoured it; the page threw the row away.
The page-level regression lives in tests/page-boot.mjs, and this is the other
half: proof that the API says what that page is now trusting it to say.

It also pins down the thing that was suspected and turned out to be false —
that granting an asset to one person opens it for everybody in their
organisation. The assertion is explicit, so if that ever becomes true it fails
here instead of being discovered by a client.

Everything runs inside one transaction that is rolled back, so it is safe to
point at staging:

    DATABASE_URL=... .venv/bin/python tests/api_access.py
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient            # noqa: E402
from sqlalchemy import select                        # noqa: E402
from sqlalchemy.exc import OperationalError          # noqa: E402
from sqlalchemy.orm import Session                   # noqa: E402

from datetime import datetime, timezone              # noqa: E402

from api.auth.deps import optional_user              # noqa: E402
from api.routes.legacy import asset_payload, inspection_payload  # noqa: E402
from api.db import engine, get_session               # noqa: E402
from api.main import app                             # noqa: E402
from api.models import (                             # noqa: E402
    Asset,
    Identity,
    AssetOrgAccess,
    AssetUserAccess,
    Image,
    Inspection,
    Membership,
    Model3D,
    Org,
    User,
)

# A tag on every row this test makes, so a failure that somehow escapes the
# rollback is obvious rather than mysterious.
TAG = f"zz-test-{uuid.uuid4().hex[:8]}"

checks = 0
failures: list[str] = []


def check(label: str, got, want):
    global checks
    checks += 1
    if got != want:
        failures.append(f"{label}: got {got!r}, wanted {want!r}")


def hub_as(client: TestClient, user) -> dict:
    """The hub payload as `user` would receive it.

    Identity is overridden rather than driven through a real cookie: the thing
    under test is the authorisation, and minting sessions would only test the
    session code a second time.
    """
    app.dependency_overrides[optional_user] = lambda: user
    r = client.get("/api/hub")
    assert r.status_code == 200, r.text
    return r.json()


def slugs(payload: dict) -> set:
    return {a["slug"] for a in payload["assets"]}


def row(payload: dict, slug: str):
    return next((a for a in payload["assets"] if a["slug"] == slug), None)


def main() -> int:
    try:
        conn = engine.connect()
    except OperationalError as exc:
        print(f"SKIPPED: no database reachable ({type(exc).__name__}).")
        print("  Start the Cloud SQL proxy (infra/04-connect-db.sh) or set DATABASE_URL.")
        return 0

    outer = conn.begin()
    db = Session(bind=conn, expire_on_commit=False)
    app.dependency_overrides[get_session] = lambda: db
    client = TestClient(app)

    try:
        # ── fixtures ────────────────────────────────────────────────────────
        pub = Asset(slug=f"{TAG}-public", name="Public One", visibility="public")
        priv = Asset(slug=f"{TAG}-private", name="Private One", visibility="private")
        org = Org(slug=f"{TAG}-org", name="Test Org")
        # Three people: one granted directly, one a member of the granted org,
        # one in that same org with nothing of their own.
        direct = User(email=f"{TAG}-direct@example.com", name="Direct", role="normal")
        member = User(email=f"{TAG}-member@example.com", name="Member", role="normal")
        other = User(email=f"{TAG}-other@example.com", name="Other", role="normal")
        # Signed in, granted nothing, in no org: the one who must get a 403
        # rather than a 401, because the refusal is about permission not login.
        stranger = User(email=f"{TAG}-stranger@example.com", name="Stranger", role="normal")
        admin = User(email=f"{TAG}-admin@example.com", name="Admin", role="admin")
        # kind='ai' is the detector: no inbox, and a login flow must never
        # reach it. It has no `identities` row by construction either.
        detector = User(email=f"{TAG}-ai@example.com", name="AI", kind="ai", role="normal")
        db.add_all([pub, priv, org, direct, member, other, stranger, admin, detector])
        db.flush()

        # An inspection needs a model, and the hub reports its point count and
        # kind, so one real row beats a nullable short cut.
        img = Image(sha256=f"{TAG}" + "0" * 56, object_path=f"{TAG}.png")
        model = Model3D(sha256=f"{TAG}" + "1" * 56, object_path=f"{TAG}.glb", kind="glb")
        db.add_all([img, model])
        db.flush()
        for asset in (pub, priv):
            db.add(Inspection(
                asset_id=asset.id, slug=f"{asset.slug}-insp", model_id=model.id,
                status="published", visibility=asset.visibility,
            ))
        db.add_all([
            Membership(org_id=org.id, user_id=member.id, role="member"),
            Membership(org_id=org.id, user_id=other.id, role="member"),
        ])
        db.flush()

        # ── anonymous ───────────────────────────────────────────────────────
        anon = hub_as(client, None)
        check("anon sees the public asset", pub.slug in slugs(anon), True)
        check("anon does not see the private asset", priv.slug in slugs(anon), False)
        check("anon cannot create", anon["canCreate"], False)
        check("anon has no user", anon["user"], None)

        # ── signed in, no grant ─────────────────────────────────────────────
        before = hub_as(client, direct)
        check("ungranted user does not see the private asset",
              priv.slug in slugs(before), False)
        check("ungranted user still sees the public asset",
              pub.slug in slugs(before), True)
        check("a normal user cannot create assets", before["canCreate"], False)

        # ── granted directly ────────────────────────────────────────────────
        db.add(AssetUserAccess(asset_id=priv.id, user_id=direct.id, role="viewer"))
        db.flush()
        after = hub_as(client, direct)
        check("granted user sees the private asset", priv.slug in slugs(after), True)
        check("granted role is reported", row(after, priv.slug)["role"], "viewer")
        check("a viewer cannot edit", row(after, priv.slug)["canEdit"], False)
        check("the private asset's inspection comes with it",
              len(row(after, priv.slug)["inspections"]), 1)
        check("point count is reported",
              row(after, priv.slug)["inspections"][0]["points"], 0)
        check("a viewer is not told about pending evaluations",
              row(after, priv.slug)["inspections"][0]["pendingTask"], None)

        # The suspicion that a personal grant leaks to the whole organisation.
        check("a personal grant does not reach an org colleague",
              priv.slug in slugs(hub_as(client, member)), False)

        # ── granted through an org ──────────────────────────────────────────
        db.add(AssetOrgAccess(asset_id=priv.id, org_id=org.id, role="editor"))
        db.flush()
        via_org = hub_as(client, member)
        check("an org member sees an asset granted to the org",
              priv.slug in slugs(via_org), True)
        check("the org role is reported", row(via_org, priv.slug)["role"], "editor")
        check("an editor may edit", row(via_org, priv.slug)["canEdit"], True)
        # `other` is in the same org, so this one SHOULD open: that is what an
        # org grant means. Stated so the two cases above cannot be confused.
        check("another member of the same org sees it too",
              priv.slug in slugs(hub_as(client, other)), True)
        # `direct` is not in the org, so the org's editor grant must not reach
        # them: their own viewer grant is all they hold.
        check("an org grant does not reach a non-member with a direct grant",
              row(hub_as(client, direct), priv.slug)["role"], "viewer")

        # Two grants on one person resolve to the stronger. Getting this
        # backwards would silently demote whoever holds both.
        db.add(AssetUserAccess(asset_id=priv.id, user_id=member.id, role="viewer"))
        db.flush()
        check("the stronger of two grants wins",
              row(hub_as(client, member), priv.slug)["role"], "editor")
        check("the stronger grant decides canEdit",
              row(hub_as(client, member), priv.slug)["canEdit"], True)

        # ── the single-asset read, which the viewer leans on ────────────────
        #
        # /asset/ used to decide for itself whether a non-public asset could be
        # shown, by asking "am I a platform admin", and refused it to the client
        # it had just been granted to. It now shows whatever this endpoint
        # serves, so the endpoint is the gate and these are its edges. The
        # viewer's own code is a three.js module the DOM harness can only parse,
        # not run, which is why the contract is pinned here instead.
        def asset_status(user, slug):
            app.dependency_overrides[optional_user] = lambda: user
            return client.get(f"/api/assets/{slug}").status_code

        check("anonymous is refused a private asset",
              asset_status(None, priv.slug), 401)
        check("anonymous may read a public asset",
              asset_status(None, pub.slug), 200)
        check("a granted client may read the private asset",
              asset_status(direct, priv.slug), 200)
        check("an org member may read it",
              asset_status(member, priv.slug), 200)
        check("a signed-in stranger is refused",
              asset_status(stranger, priv.slug), 403)

        # ── editor edits; it does not hand out access ───────────────────────
        #
        # The hole this closes: all three access routes took `editor`, so an
        # editor on one asset could grant `editor` on that asset to anybody,
        # themselves and any outsider included. An escalation reachable by
        # whoever was given the weakest write role we hand out.
        db.add(AssetUserAccess(asset_id=priv.id, user_id=other.id, role="editor"))
        db.flush()

        def as_user(u):
            app.dependency_overrides[optional_user] = lambda: u
            return u

        for label, u, want in (("an editor", other, 403),
                               ("a viewer", direct, 403),
                               ("a stranger", stranger, 403),
                               ("an anonymous caller", None, 401),
                               ("an admin", admin, 200)):
            as_user(u)
            check(f"{label} listing access", 
                  client.get(f"/api/assets/{priv.slug}/access").status_code, want)
            check(f"{label} granting access",
                  client.put(f"/api/assets/{priv.slug}/access",
                             json={"email": "nobody@example.com", "role": "viewer"}
                             ).status_code, want)
            check(f"{label} revoking access",
                  client.delete(f"/api/assets/{priv.slug}/access"
                                "?email=nobody@example.com").status_code, want)

        # And the UI is told the same thing rather than inferring it.
        as_user(other)
        check("an editor is not offered access management",
              row(hub_as(client, other), priv.slug)["canManageAccess"], False)
        check("an editor can still edit",
              row(hub_as(client, other), priv.slug)["canEdit"], True)
        check("an admin is offered access management",
              row(hub_as(client, admin), priv.slug)["canManageAccess"], True)

        # ── splat or GLB, for an asset whose only scan is a draft ───────────
        #
        # The `<slug>-baseline` row carries the model of an asset that has no
        # survey yet, and it is a draft so it stays out of client timelines.
        # The hub read only published rows, so such an asset was badged GLB on
        # its card while the viewer rendered a splat.
        splat_model = Model3D(sha256=f"{TAG}" + "3" * 56,
                              object_path=f"{TAG}.splat", kind="splat")
        splat_asset = Asset(slug=f"{TAG}-splat", name="Splat Only", visibility="public")
        db.add_all([splat_model, splat_asset])
        db.flush()
        db.add(Inspection(
            asset_id=splat_asset.id, slug=f"{splat_asset.slug}-baseline",
            model_id=splat_model.id, status="draft", visibility="public",
        ))
        db.flush()
        splat_row = row(hub_as(client, admin), splat_asset.slug)
        check("an asset whose only scan is a draft is still listed",
              splat_row is not None, True)
        check("and it is badged as a splat", splat_row["kind"], "splat")
        check("its draft baseline stays out of the inspection list",
              len(splat_row["inspections"]), 0)

        # ── which scan an inspection renders ────────────────────────────────
        #
        # `asset_payload` reports the asset's LATEST inspection's model, which
        # is right for the asset page. Merged under an inspection it meant
        # asking for inspection X and getting inspection Y's scan: the landing
        # carousel asks for one featured inspection and was handed whichever
        # flight was newest. Invisible while every inspection of an asset shares
        # one blob, wrong the moment one is re-flown — so the fixture re-flies
        # one.
        from api.routes.legacy import resolved_payload

        newer = Model3D(sha256=f"{TAG}" + "2" * 56, object_path=f"{TAG}-newer.glb", kind="glb")
        db.add(newer)
        db.flush()
        old_insp = db.scalar(select(Inspection).where(Inspection.asset_id == pub.id))
        new_insp = Inspection(
            asset_id=pub.id, slug=f"{pub.slug}-insp-2", model_id=newer.id,
            status="published", visibility="public",
            captured_at=datetime(2030, 1, 1, tzinfo=timezone.utc),
        )
        old_insp.captured_at = datetime(2020, 1, 1, tzinfo=timezone.utc)
        db.add(new_insp)
        db.flush()

        check("the asset reports its latest scan",
              asset_payload(db, pub)["modelName"], f"{TAG}-newer.glb")
        check("the older inspection renders its OWN scan",
              resolved_payload(db, old_insp)["composed"]["modelName"], f"{TAG}.glb")
        check("the newer inspection renders its own scan",
              resolved_payload(db, new_insp)["composed"]["modelName"], f"{TAG}-newer.glb")
        check("the raw inspection payload still carries no model, as the files do",
              "model" in inspection_payload(db, old_insp), False)

        # ── signing in with any address at all ──────────────────────────────
        #
        # Google and Microsoft do not cover everybody; a client on a company
        # domain running neither is the case this exists for. Four properties
        # make it safe, and each is a hole without its assertion:
        #   · it never creates an account, so it is not a self-service door
        #   · it never reaches a non-human account, which has no inbox
        #   · it is rate limited, or it is a mail amplifier pointed at anyone
        #   · it is single use and short lived
        #
        # `issue()` flushes and never commits, so all of this runs inside the
        # same rolled-back transaction.
        from api.auth import email_link

        # TAG-scoped: an earlier assertion in this same run grants access to a
        # literal address, which creates it as an invited user. Reusing that
        # address here asserted the opposite of what it reads as.
        check("an address with no account gets no link",
              email_link.issue(db, f"{TAG}-stranger-to-us@example.com", "/"), None)
        check("the detector cannot be sent a login link",
              email_link.issue(db, f"{TAG}-ai@example.com", "/"), None)

        tokens = [email_link.issue(db, direct.email, "/assets/") for _ in range(5)]
        check("the first three requests get a link",
              [t is not None for t in tokens[:3]], [True, True, True])
        check("further requests inside the window get none",
              [t is None for t in tokens[3:]], [True, True])

        user, next_path = email_link.redeem(db, tokens[0])
        check("the link signs in its own address", user.email, direct.email)
        check("it lands where it was asked to", next_path, "/assets/")
        check("redeeming records how this person signs in",
              db.scalar(select(Identity.provider).where(
                  Identity.user_id == user.id, Identity.provider == "email")), "email")

        try:
            email_link.redeem(db, tokens[0])
            check("a used link cannot be redeemed twice", "no error", "Rejected")
        except email_link.Rejected as rejected:
            check("a used link says so, rather than 'invalid'", rejected.reason, "used")
        try:
            email_link.redeem(db, "not-a-real-token")
            check("a bogus token is refused", "no error", "Rejected")
        except email_link.Rejected as rejected:
            check("a bogus token reads as invalid", rejected.reason, "invalid")

        # ── admin ───────────────────────────────────────────────────────────
        as_admin = hub_as(client, admin)
        check("an admin sees both", {pub.slug, priv.slug} <= slugs(as_admin), True)
        check("an admin holds editor", row(as_admin, priv.slug)["role"], "editor")
        check("an admin may create", as_admin["canCreate"], True)
        check("an admin is flagged as one", as_admin["user"]["isAdmin"], True)

    finally:
        app.dependency_overrides.clear()
        db.close()
        outer.rollback()
        conn.close()

    for f in failures:
        print(f"  ✗ {f}")
    print(f"{'FAILED' if failures else 'ok'}: {checks - len(failures)}/{checks} checks")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
