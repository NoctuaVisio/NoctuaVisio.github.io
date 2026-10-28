"""Compare what the API emits against the JSON files it replaces.

Exits non-zero if any inspection or asset diverges. Comparison is semantic, not
byte-for-byte: '20' and '20.0' are the same number, an absent key and a null are
the same absence. Anything else is a real difference and gets printed with its
path so it can be fixed rather than explained away.

    python -m api.scripts.check_parity [--root .]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

from sqlalchemy import select

from api.db import SessionLocal
from api.models import Asset, EvalTask, Inspection
from api.routes.legacy import asset_payload, inspection_payload, resolved_payload


# A V4 signature is transport, not data: the same object signed twice yields two
# different strings for the identical bytes. Compare what the URL POINTS AT.
# Only the signing parameters are dropped — any other query survives, so a real
# difference in the URL still fails the comparison.
SIGNING_PARAMS = (
    "X-Goog-Algorithm", "X-Goog-Credential", "X-Goog-Date",
    "X-Goog-Expires", "X-Goog-SignedHeaders", "X-Goog-Signature",
)


def object_identity(url: str) -> str:
    """'https://…/noctua-models/abc.glb?X-Goog-…' -> 'https://…/noctua-models/abc.glb'"""
    base, _, query = url.partition("?")
    if not query:
        return url
    kept = [
        part for part in query.split("&")
        if part.split("=", 1)[0] not in SIGNING_PARAMS
    ]
    return base + ("?" + "&".join(kept) if kept else "")


def norm(v: Any) -> Any:
    """Collapse the differences that carry no meaning."""
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return round(float(v), 6)
    if isinstance(v, str):
        s = v.strip()
        if s in ("", "—", "-", "–"):
            return None
        if s.startswith(("http://", "https://")):
            return object_identity(s)
        # '0.004 m²' and '0.004' compare as the same number.
        # '102,59 m²' is the same number as '102.59 m²'.
        bare = s.removesuffix("m²").strip().replace(",", ".")
        try:
            return round(float(bare), 6)
        except ValueError:
            pass
        try:
            return round(float(s), 6)
        except ValueError:
            pass
        # '…T21:18:24Z' and '…T21:18:24.000Z' are the same instant written two
        # ways. Compare the moment, not the spelling.
        try:
            return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
        except ValueError:
            return s
    if isinstance(v, list):
        return [norm(x) for x in v]
    if isinstance(v, dict):
        # `_`-prefixed keys are prose for whoever opens the file, not data.
        return {k: norm(x) for k, x in v.items()
                if not k.startswith("_") and norm(x) is not None}
    return v


# Keys the legacy files may omit, and what that omission means. Applied to the
# FILE side before comparing, so an explicit value in the API is not reported as
# a difference from an absence that always meant the same thing.
LEGACY_DEFAULTS = {"requireLogin": True}


def diff(a: Any, b: Any, path: str = "") -> list[str]:
    a, b = norm(a), norm(b)
    if isinstance(a, dict) and isinstance(b, dict):
        for k, default in LEGACY_DEFAULTS.items():
            if k in b and k not in a:
                a = {**a, k: default}
        out = []
        for k in sorted(set(a) | set(b)):
            out += diff(a.get(k), b.get(k), f"{path}.{k}" if path else k)
        return out
    if isinstance(a, list) and isinstance(b, list):
        if len(a) != len(b):
            return [f"{path}: tamanho {len(a)} (arquivo) vs {len(b)} (api)"]
        out = []
        for i, (x, y) in enumerate(zip(a, b)):
            out += diff(x, y, f"{path}[{i}]")
        return out
    if a != b:
        return [f"{path}: {a!r} (arquivo) vs {b!r} (api)"]
    return []


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=".")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()
    root = Path(args.root).resolve()

    failures = 0
    checked = 0
    with SessionLocal() as s:
        print("── assets ─────────────────────────────────────────")
        for slug in json.loads((root / "assets/index.json").read_text()):
            f = json.loads((root / f"assets/{slug}.json").read_text())
            a = s.scalar(select(Asset).where(Asset.slug == slug))
            if not a:
                print(f"  ✗ {slug}: ausente no banco")
                failures += 1
                continue
            d = diff(f, asset_payload(s, a))
            checked += 1
            if d:
                failures += 1
                print(f"  ✗ {slug}")
                for line in d:
                    print(f"      {line}")
            elif args.verbose:
                print(f"  ✓ {slug}")

        print("── inspections ────────────────────────────────────")
        for slug in json.loads((root / "inspections/index.json").read_text()):
            f = json.loads((root / f"inspections/{slug}.json").read_text())
            i = s.scalar(select(Inspection).where(Inspection.slug == slug))
            if not i:
                print(f"  ✗ {slug}: ausente no banco")
                failures += 1
                continue
            d = diff(f, inspection_payload(s, i))
            checked += 1
            if d:
                failures += 1
                print(f"  ✗ {slug}  ({len(d)} divergências)")
                for line in d[:12]:
                    print(f"      {line}")
                if len(d) > 12:
                    print(f"      … mais {len(d) - 12}")
            elif args.verbose:
                print(f"  ✓ {slug}")

        print("── inspections ?resolved=1 ────────────────────────")
        for slug in json.loads((root / "inspections/index.json").read_text()):
            insp_file = json.loads((root / f"inspections/{slug}.json").read_text())
            asset_file = json.loads(
                (root / f"assets/{insp_file['asset']}.json").read_text()
            )
            # Exactly what inspection-resolver.js builds:
            #   Object.assign({}, asset, inspection, { project: asset.name })
            expected = {**asset_file, **insp_file, "project": asset_file.get("name")}
            i = s.scalar(select(Inspection).where(Inspection.slug == slug))
            got = resolved_payload(s, i)
            d = diff(expected, got["composed"])
            checked += 1
            if d:
                failures += 1
                print(f"  ✗ {slug}  ({len(d)} divergências)")
                for line in d[:8]:
                    print(f"      {line}")
            elif args.verbose:
                print(f"  ✓ {slug}")

        print("── landing-models ─────────────────────────────────")
        from api.routes.legacy import landing_models

        f = json.loads((root / "landing-models.json").read_text())
        d = diff(f, landing_models(s))
        checked += 1
        if d:
            failures += 1
            for line in d:
                print(f"      {line}")

    print()
    print(f"{checked} recursos comparados, {failures} com divergência")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
