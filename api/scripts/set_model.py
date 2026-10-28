"""Point an inspection at a model that is already in the bucket.

Used after `infra/cloudbuild-optimize-model.yaml` produces a smaller copy of a
GLB: the bytes are already in GCS, so there is nothing to upload and the only
thing left is to say which scan an inspection renders.

Goes through `api.ingest.ensure_model`, the same path the importer and the write
API use, so the row is content-addressed and shaped identically either way. The
transform (rotation, offset, scale) is carried over from the model being
replaced, because an optimised copy of a scan sits exactly where the original
sat — losing it would drop the hero model on its side.

The old Model3D row is left alone. Blobs are shared and reclaiming orphans is
`write.reclaim_orphan_blobs`'s job, which runs on delete and knows every
reference; guessing here is how a model still in use gets deleted.

    python -m api.scripts.set_model <inspection-slug> <model-url> [--dry-run]
"""
from __future__ import annotations

import argparse
import sys

from sqlalchemy import select

from api.db import SessionLocal
from api.ingest import ensure_model
from api.models import AuditLog, Inspection, Model3D, User


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug")
    ap.add_argument("url", help="public GCS URL of the model")
    ap.add_argument("--actor", default=None, help="email to record in the audit log")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    with SessionLocal() as db:
        insp = db.scalar(select(Inspection).where(Inspection.slug == args.slug))
        if not insp:
            print(f"no inspection '{args.slug}'")
            return 1
        old = db.get(Model3D, insp.model_id)
        actor = (
            db.scalar(select(User).where(User.email == args.actor))
            if args.actor
            else db.scalar(select(User).where(User.role == "admin").order_by(User.created_at))
        )
        if not actor:
            print("no actor to attribute this to (pass --actor <email>)")
            return 1

        payload = {
            "model": args.url,
            "kind": old.kind if old else None,
            "modelRotation": old.rotation if old else None,
            "modelOffset": old.offset if old else None,
            "modelScale": float(old.scale) if old and old.scale is not None else None,
        }
        new = ensure_model(db, payload, actor)
        if new is None:
            print("could not resolve a model from that URL")
            return 1
        if new.id == insp.model_id:
            print("already pointing there; nothing to do")
            return 0

        print(f"{args.slug}")
        print(f"  from {old.object_path if old else '(none)'}")
        print(f"  to   {new.object_path}")
        print(f"  transform carried over: rotation={new.rotation} offset={new.offset} scale={new.scale}")
        if args.dry_run:
            db.rollback()
            print("dry run, nothing written")
            return 0

        insp.model_id = new.id
        db.add(AuditLog(
            user_id=actor.id, action="inspection.model.replace",
            subject_type="inspection", subject_id=args.slug,
            meta={"from": old.object_path if old else None, "to": new.object_path},
        ))
        db.commit()
        print("done")
        return 0


if __name__ == "__main__":
    sys.exit(main())
