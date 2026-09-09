#!/usr/bin/env python3
"""The canonical Scruple Merkle construction, implemented from RFC 6962 §2.1.

WO-C6. ⚑ THIS IS A SECOND IMPLEMENTATION ON PURPOSE, AND IT MUST NOT IMPORT
THE FIRST. `scripts/merkle-canonical-spec.mjs` generates
`test/vectors/merkle-vectors.json`; this file RECOMPUTES every root and every
proof in that file from the leaf hashes alone. A Python module that read the
roots out of the vector file would agree by construction and would go on
agreeing after the JavaScript changed — the same discipline
`scripts/gen-retention-policy-vectors.mjs` sets out in its header, for the same
reason.

It has a second job. The witness is JavaScript, the host SDK is Python, and the
council's release blocker is that "witness and verifier pass SHARED VECTORS".
Two languages arriving at one root from one written spec is what makes the spec
a spec rather than a description of one program's behaviour.

Run: python3 scripts/merkle_canonical.py            # recompute + check vectors
"""

import hashlib
import json
import os
import sys

LEAF_TAG = b"\x00"  # RFC 6962 §2.1 — leaf
NODE_TAG = b"\x01"  # RFC 6962 §2.1 — interior node

MERKLE_VERSION = 1
MERKLE_ALGORITHM_ID = "scruple-merkle-rfc6962-sha256-v1"


def _sha256(b: bytes) -> bytes:
    return hashlib.sha256(b).digest()


def leaf_bytes(leaf_hash_hex: str) -> bytes:
    """d(i) is the 32 DECODED bytes, never the 64-char ASCII hex."""
    if not isinstance(leaf_hash_hex, str) or len(leaf_hash_hex) != 64:
        raise ValueError(f"leaf_hash must be 64 hex chars, got {leaf_hash_hex!r}")
    return bytes.fromhex(leaf_hash_hex)


def hash_leaf(leaf_hash_hex: str) -> bytes:
    return _sha256(LEAF_TAG + leaf_bytes(leaf_hash_hex))


def hash_node(left: bytes, right: bytes) -> bytes:
    return _sha256(NODE_TAG + left + right)


def split_point(n: int) -> int:
    """RFC 6962's k: the largest power of two STRICTLY LESS than n."""
    if n < 2:
        raise ValueError(f"split_point requires n >= 2, got {n}")
    k = 1
    while k * 2 < n:
        k *= 2
    return k


def mth(leaves) -> bytes:
    n = len(leaves)
    if n == 0:
        return _sha256(b"")
    if n == 1:
        return hash_leaf(leaves[0])
    k = split_point(n)
    return hash_node(mth(leaves[:k]), mth(leaves[k:]))


def merkle_root(leaves) -> str:
    return mth(leaves).hex()


def inclusion_path(index: int, leaves):
    """PATH(m, D[n]) — RFC 6962 §2.1.1. Bottom-up, no sides."""
    n = len(leaves)
    if not 0 <= index < n:
        raise ValueError(f"leaf index {index} out of range [0, {n})")
    if n == 1:
        return []
    k = split_point(n)
    if index < k:
        return inclusion_path(index, leaves[:k]) + [mth(leaves[k:]).hex()]
    return inclusion_path(index - k, leaves[k:]) + [mth(leaves[:k]).hex()]


def root_from_proof(proof) -> str:
    """RFC 6962 §2.1.2. The sides are DERIVED from (leaf_index, tree_size);
    nothing carried in the proof chooses them. That is what binds the index."""
    n = proof["tree_size"]
    m = proof["leaf_index"]
    if not isinstance(n, int) or n < 1:
        raise ValueError(f"bad tree_size: {n}")
    if not 0 <= m < n:
        raise ValueError(f"leaf_index {m} out of range [0, {n})")
    fn, sn = m, n - 1
    r = hash_leaf(proof["leaf_hash"])
    for step in proof["path"]:
        if sn == 0:
            raise ValueError("inclusion path too long for this tree_size")
        p = leaf_bytes(step)
        if fn % 2 == 1 or fn == sn:
            r = hash_node(p, r)
            while fn % 2 == 0 and fn != 0:
                fn >>= 1
                sn >>= 1
        else:
            r = hash_node(r, p)
        fn >>= 1
        sn >>= 1
    if sn != 0:
        raise ValueError("inclusion path too short for this tree_size")
    return r.hex()


# ---------------------------------------------------------------------------
# Recomputation of the shared vector file.
# ---------------------------------------------------------------------------

def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "..", "test", "vectors", "merkle-vectors.json")
    with open(path, "r", encoding="utf-8") as fh:
        doc = json.load(fh)

    failures = []
    checked = 0

    if doc["algorithm"]["id"] != MERKLE_ALGORITHM_ID:
        failures.append(f"algorithm id mismatch: {doc['algorithm']['id']}")
    if doc["algorithm"]["merkle_version"] != MERKLE_VERSION:
        failures.append("merkle_version mismatch")

    for vec in doc["canonical"]:
        leaves = vec["leaves"]
        got = merkle_root(leaves)
        checked += 1
        if got != vec["root"]:
            failures.append(f"{vec['name']}: root {got} != {vec['root']}")
        for proof in vec.get("proofs", []):
            checked += 1
            mine = inclusion_path(proof["leaf_index"], leaves)
            if mine != proof["path"]:
                failures.append(f"{vec['name']}[{proof['leaf_index']}]: path differs")
            if root_from_proof(proof) != vec["root"]:
                failures.append(f"{vec['name']}[{proof['leaf_index']}]: proof does not reach root")

    # The refusals must refuse HERE TOO, or one language accepts what the
    # other rejects and the "shared vectors" claim is half true.
    for ref in doc["refused_proofs"]:
        checked += 1
        try:
            got = root_from_proof(ref["proof"])
            reached = got == ref["true_root"]
        except Exception:
            reached = False
        if reached:
            failures.append(f"REFUSAL FAILED — {ref['name']} verified against the true root")

    # ⚑ And the mirror: the cases the walk CANNOT refuse must still verify here,
    # or a future "hardening" of the walk would silently break honest proofs
    # while the vector file went on looking green.
    for nr in doc["not_refusable_by_walk"]:
        checked += 1
        got = root_from_proof(nr["proof"])
        if (got == nr["true_root"]) != nr["verifies_under_the_walk"]:
            failures.append(
                f"{nr['name']}: expected verifies_under_the_walk="
                f"{nr['verifies_under_the_walk']}, got {got == nr['true_root']}"
            )

    # The ambiguity cases are the reason duplicate-last is not the canonical
    # rule. Under the canonical rule they must be DIFFERENT roots.
    for amb in doc["ambiguity"]:
        checked += 1
        a = merkle_root(amb["leaves_a"])
        b = merkle_root(amb["leaves_b"])
        if a == b:
            failures.append(f"{amb['name']}: canonical rule collides too — {a}")
        if a != amb["canonical_root_a"] or b != amb["canonical_root_b"]:
            failures.append(f"{amb['name']}: recorded canonical roots do not recompute")

    print(f"python recomputation: {checked} checks over {len(doc['canonical'])} trees")
    if failures:
        for f in failures:
            print(f"  FAIL {f}")
        return 1
    print("  ALL PASS — an independent Python implementation reaches every root "
          "and every path in the shared vectors, and refuses every refusal.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
