"""Cross-language parity test — Python side, v2.4.

Reads test/fixtures/canonical-leaf-v24-vectors.json and verifies the
Python twin produces byte-identical output to the TypeScript module.

Run:
    python3 services/witness/tests/test_canonical_leaf_v24.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from canonical_leaf_v24 import (  # noqa: E402
    canonical_leaf_v24,
    chain_hash_v24,
    leaf_hash_v24,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURE = REPO_ROOT / "test" / "fixtures" / "canonical-leaf-v24-vectors.json"


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

        kwargs = dict(
            tenant_id=inp.get("tenant_id", ""),
            principal_id=inp.get("principal_id", ""),
            stream_id=inp.get("stream_id", ""),
            tenant_seq=inp.get("tenant_seq", 0),
            event_time=inp.get("event_time", ""),
            payload_hash=inp.get("payload_hash", ""),
            workflow_hash=inp.get("workflow_hash", ""),
            machine_manifest_hash=inp.get("machine_manifest_hash", ""),
            dims=inp.get("dims"),
        )

        preimage = canonical_leaf_v24(**kwargs)
        computed_hash = leaf_hash_v24(**kwargs)

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
            print(f"[{name}] MISSING expected_chain_hash", file=sys.stderr)
            failures += 1
            continue
        computed = chain_hash_v24(c["prev_chain_hash"], c["leaf_hash"])
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
