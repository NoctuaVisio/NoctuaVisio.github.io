"""Import the repo's JSON files into Postgres.

Idempotent: assets, users and orgs are upserted by natural key; everything that
belongs to an inspection (photos, anomalies, evaluations, annotations) is wiped
and rebuilt from the file, because the file is the source of truth until cutover.

    python -m api.scripts.import_json [--root .] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from sqlalchemy import delete, select

from api.db import SessionLocal
from api.ingest import (
    Counter,
    ensure_image,
    ensure_model,
    fdatetime,
    ftext,
    upsert_asset,
    upsert_inspection,
)
from api.models import Asset, EvalTask, Featured, Inspection, Model3D, Org, User

OPERATOR_EMAIL = "contact@noctuavisio.com"
AI_EMAIL = "detector@ai.noctua.internal"
DEFAULT_BUCKET = "noctua-models"
EMPTY = {"", "—", "-", "–", "n/a", "N/A", "None", None}


# ───────────────────────────── parsing helpers ──────────────────────────────

class Importer:
    def __init__(self, root: Path, session):
        self.root = root
        self.s = session
        self._counter = Counter()
        self.report = self._counter.data
        self.warnings: list[str] = []

    def bump(self, key: str, n: int = 1) -> None:
        self._counter.bump(key, n)

    # -- seeds ---------------------------------------------------------------

    def seed(self) -> None:
        self.org = self.s.scalar(select(Org).where(Org.slug == "noctua"))
        if not self.org:
            self.org = Org(slug="noctua", name="Noctua")
            self.s.add(self.org)
            self.bump("orgs")

        self.operator = self.get_or_create_user(
            OPERATOR_EMAIL, name="Noctua", kind="human", role="admin"
        )
        # The detector exists from day one so AI-authored rows have an author to
        # point at. No `identities` row, so it can never sign in.
        self.ai = self.get_or_create_user(
            AI_EMAIL, name="Noctua Visão", kind="ai", role="normal"
        )
        self.s.flush()

    def get_or_create_user(self, email: str, *, name: str, kind: str, role: str) -> User:
        email = email.lower()
        u = self.s.scalar(select(User).where(User.email == email))
        if not u:
            u = User(email=email, name=name, kind=kind, role=role)
            self.s.add(u)
            self.bump("users")
        return u

    # -- blobs ---------------------------------------------------------------

    def import_assets(self) -> None:
        self.assets: dict[str, Asset] = {}
        self.asset_models: dict[str, Model3D] = {}
        for slug in self.read_index("assets"):
            j = self.read_json(f"assets/{slug}.json")
            if j is None:
                continue
            a = upsert_asset(self.s, slug, j, self.operator, count=self._counter)
            a.owner_org_id = self.org.id
            self.s.flush()
            self.assets[slug] = a
            model = ensure_model(self.s, j, self.operator, self._counter)
            if model:
                self.asset_models[slug] = model
            else:
                self.warnings.append(f"asset {slug}: sem modelo 3D")

    def import_inspections(self) -> None:
        self.inspections: dict[str, Inspection] = {}
        for slug in self.read_index("inspections"):
            j = self.read_json(f"inspections/{slug}.json")
            if j is None:
                continue
            try:
                insp = upsert_inspection(
                    self.s, slug, j, self.operator,
                    count=self._counter, warnings=self.warnings,
                    # The asset's model, created a moment ago in import_assets:
                    # the inspection being created is the first on this asset,
                    # so there is nothing for the join to find.
                    fallback_model=self.asset_models.get(j.get("asset")),
                )
            except ValueError as err:
                self.warnings.append(f"inspection {slug}: {err} — pulada")
                continue
            self.inspections[slug] = insp

    def import_baseline_inspections(self) -> None:
        for slug, asset in self.assets.items():
            has = self.s.scalar(
                select(Inspection.id).where(Inspection.asset_id == asset.id).limit(1)
            )
            if has:
                continue
            model = self.asset_models.get(slug)
            if not model:
                continue
            baseline_slug = f"{slug}-baseline"
            insp = self.s.scalar(select(Inspection).where(Inspection.slug == baseline_slug))
            if not insp:
                insp = Inspection(slug=baseline_slug)
                self.s.add(insp)
                self.bump("inspections_baseline")
            insp.asset_id = asset.id
            insp.model_id = model.id
            insp.captured_at = fdatetime(self.read_json(f"assets/{slug}.json").get("createdAt"))
            insp.status = "draft"          # keeps it out of the client timeline
            insp.visibility = asset.visibility
            insp.created_by = self.operator.id
            insp.inspector_id = self.operator.id
            insp.og_title = asset.name
            self.s.flush()
            self.inspections[baseline_slug] = insp

    # -- tasks and landing ---------------------------------------------------

    def import_tasks(self) -> None:
        tasks_dir = self.root / "tasks"
        if not tasks_dir.is_dir():
            return
        for f in sorted(tasks_dir.glob("*.json")):
            j = self.read_json(f"tasks/{f.name}")
            if not isinstance(j, dict):
                continue
            insp = self.inspections.get(j.get("inspection"))
            if not insp:
                self.warnings.append(f"task {f.name}: inspeção '{j.get('inspection')}' inexistente — pulada")
                continue
            legacy = ftext(j.get("id")) or f.stem
            t = self.s.scalar(select(EvalTask).where(EvalTask.legacy_id == legacy))
            if not t:
                t = EvalTask(legacy_id=legacy)
                self.s.add(t)
                self.bump("eval_tasks")
            t.inspection_id = insp.id
            t.kind = ftext(j.get("kind"))
            t.status = j.get("status") if j.get("status") in ("pending", "running", "done") else "pending"
            t.align = j.get("align")
            t.source = j.get("source")
            t.payload = {k: v for k, v in j.items()
                         if k not in ("id", "kind", "status", "align", "source", "inspection")}
            t.created_by = self.operator.id
            created_at = fdatetime(j.get("createdAt"))
            if created_at:
                t.created_at = created_at
        self.s.flush()

    def import_featured(self) -> None:
        j = self.read_json("landing-models.json") or {}
        slugs = j.get("inspections") or []
        self.s.execute(delete(Featured))
        for i, slug in enumerate(slugs):
            insp = self.inspections.get(slug)
            if not insp:
                self.warnings.append(f"landing: inspeção '{slug}' inexistente — ignorada")
                continue
            self.s.add(Featured(inspection_id=insp.id, position=i))
            self.bump("featured")
        self.s.flush()

    # -- io ------------------------------------------------------------------

    def read_json(self, rel: str) -> Any:
        p = self.root / rel
        if not p.is_file():
            return None
        with p.open() as fh:
            return json.load(fh)

    def read_index(self, dirname: str) -> list[str]:
        idx = self.read_json(f"{dirname}/index.json")
        if isinstance(idx, list):
            return idx
        return sorted(
            p.stem for p in (self.root / dirname).glob("*.json") if p.stem != "index"
        )

    def run(self) -> None:
        self.seed()
        self.import_assets()
        self.import_inspections()
        self.import_baseline_inspections()
        self.import_tasks()
        self.import_featured()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=os.environ.get("SITE_ROOT", "."))
    ap.add_argument("--dry-run", action="store_true", help="roll back at the end")
    args = ap.parse_args()

    root = Path(args.root).resolve()
    with SessionLocal() as session:
        imp = Importer(root, session)
        imp.run()
        if args.dry_run:
            session.rollback()
        else:
            session.commit()

    width = max((len(k) for k in imp.report), default=0)
    print(f"\n{'DRY RUN — nada gravado' if args.dry_run else 'importado'} de {root}")
    for k in sorted(imp.report):
        print(f"  {k:<{width}}  {imp.report[k]}")
    if imp.warnings:
        print(f"\n{len(imp.warnings)} avisos:")
        for w in imp.warnings:
            print(f"  ! {w}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
