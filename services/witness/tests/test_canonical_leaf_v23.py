"""Cross-language parity test — Python side.

Reads the same test/fixtures/canonical-leaf-v23-vectors.json that the
TypeScript test uses. The expected_preimage and expected_leaf_hash values
in that file are frozen by the TypeScript --freeze pass; this test
verifies the Python implementation produces byte-identical output.

Run:
    python3 services/witness/tests/test_canonical_leaf_v23.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# Make sibling package importable when run from repo root.
sys.path.insert(
    0, str(Path(__file__).resolve().parent.parent)
)

from canonical_leaf_v23 import (  # noqa: E402
    canonical_leaf_v23,
    chain_hash_v23,
    leaf_hash_v23,
)

# services/witness/tests/test_canonical_leaf_v23.py → repo root is 4 up.
REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = REPO_ROOT / "test" / "fixtures" / "canonical-leaf-v23-vectors.json"


def main() -> int:
    with open(FIXTURE, encoding="utf-8") as f:
        fixture = json.load(f)

    failures = 0

    for v in fixture["vectors"]:
        name = v["name"]
        inp = v["input"]

        expected_preimage = v.get("expected_preimage")
        expected_hash = v.get("expected_leaf_hash")
        if expected_preimage is None or expected_hash is None:
            print(
                f"[{name}] MISSING expected values — TS side must be "
                "run with --freeze first",
                file=sys.stderr,
            )
            failures += 1
            continue

        preimage = canonical_leaf_v23(
            tenant_id=inp.get("tenant_id", ""),
            principal_id=inp.get("principal_id", ""),
            stream_id=inp.get("stream_id", ""),
            tenant_seq=inp.get("tenant_seq", 0),
            event_time=inp.get("event_time", ""),
            payload_hash=inp.get("payload_hash", ""),
            dims=inp.get("dims"),
        )
        computed_hash = leaf_hash_v23(
            tenant_id=inp.get("tenant_id", ""),
            principal_id=inp.get("principal_id", ""),
            stream_id=inp.get("stream_id", ""),
            tenant_seq=inp.get("tenant_seq", 0),
            event_time=inp.get("event_time", ""),
            payload_hash=inp.get("payload_hash", ""),
            dims=inp.get("dims"),
        )

        if preimage != expected_preimage:
            print(f"[{name}] PREIMAGE MISMATCH", file=sys.stderr)
            print(f"  expected: {expected_preimage}", file=sys.stderr)
            print(f"  got:      {preimage}", file=sys.stderr)
            failures += 1
        if computed_hash != expected_hash:
            print(f"[{name}] LEAF_HASH MISMATCH", file=sys.stderr)
            print(f"  expected: {expected_hash}", file=sys.stderr)
            print(f"  got:      {computed_hash}", file=sys.stderr)
            failures += 1

    for c in fixture["chain_hash_vectors"]:
        name = c["name"]
        expected_chain = c.get("expected_chain_hash")
        if expected_chain is None:
            print(
                f"[{name}] MISSING expected_chain_hash — TS --freeze first",
                file=sys.stderr,
            )
            failures += 1
            continue
        computed = chain_hash_v23(c["prev_chain_hash"], c["leaf_hash"])
        if computed != expected_chain:
            print(f"[{name}] CHAIN_HASH MISMATCH", file=sys.stderr)
            print(f"  expected: {expected_chain}", file=sys.stderr)
            print(f"  got:      {computed}", file=sys.stderr)
            failures += 1

    if failures > 0:
        print(f"\nFAIL — {failures} mismatch(es)", file=sys.stderr)
        return 1

    print(
        f"PASS — {len(fixture['vectors'])} leaf vectors + "
        f"{len(fixture['chain_hash_vectors'])} chain vectors verified."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
