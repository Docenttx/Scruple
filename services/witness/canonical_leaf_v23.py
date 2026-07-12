"""Canonical leaf preimage for the Scruple audit log — Python twin.

Byte-for-byte parity with lib/witness/canonicalLeafV23.ts. Any change to
one MUST land in the other in the same commit; the parity vector tests in
scripts/test-canonical-leaf-v23.ts and services/witness/tests/
test_canonical_leaf_v23.py are the CI gate that enforces this.

See the TypeScript module header for the version-bump discipline.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Optional

LEAF_V23_FIELD_ORDER = (
    "tenant_id",
    "principal_id",
    "stream_id",
    "tenant_seq",
    "event_time",
    "payload_hash",
    "dims",
)

CHAIN_HASH_ZERO = "0" * 64


def canonical_leaf_v23(
    *,
    tenant_id: str,
    stream_id: str,
    tenant_seq: int,
    event_time: str,
    payload_hash: str,
    principal_id: str = "",
    dims: Optional[Dict[str, str]] = None,
) -> str:
    """Return the canonical UTF-8 preimage string for a leaf.

    Rules match the TypeScript twin — fixed field order, empty-string
    defaults for missing string fields, 0 for missing tenant_seq, sorted
    dims keys, compact JSON with no whitespace.
    """
    dims = dims or {}
    sorted_dims: Dict[str, str] = {k: dims[k] for k in sorted(dims.keys())}
    payload: Dict[str, Any] = {
        "tenant_id": tenant_id,
        "principal_id": principal_id,
        "stream_id": stream_id,
        "tenant_seq": tenant_seq,
        "event_time": event_time,
        "payload_hash": payload_hash,
        "dims": sorted_dims,
    }
    # `separators=(",", ":")` produces compact JSON matching JS's
    # JSON.stringify() default output. `ensure_ascii=False` matches
    # Node's default UTF-8 pass-through.
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def leaf_hash_v23(**kwargs: Any) -> str:
    """Return lowercase 64-hex SHA-256 of the canonical preimage."""
    preimage = canonical_leaf_v23(**kwargs)
    return hashlib.sha256(preimage.encode("utf-8")).hexdigest()


def chain_hash_v23(prev_chain_hash_hex: str, leaf_hash_hex: str) -> str:
    """Compute chain_hash = sha256(prev_chain_hash_bytes || leaf_hash_bytes)."""
    if len(prev_chain_hash_hex) != 64:
        raise ValueError(
            f"prev_chain_hash must be 64 hex chars, got {len(prev_chain_hash_hex)}"
        )
    if len(leaf_hash_hex) != 64:
        raise ValueError(
            f"leaf_hash must be 64 hex chars, got {len(leaf_hash_hex)}"
        )
    prev = bytes.fromhex(prev_chain_hash_hex)
    leaf = bytes.fromhex(leaf_hash_hex)
    return hashlib.sha256(prev + leaf).hexdigest()
