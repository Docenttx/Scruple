"""Canonical leaf preimage for the Scruple audit log — Python twin, v2.4.

Byte-for-byte parity with lib/witness/canonicalLeafV24.ts. Any change to
one MUST land in the other in the same commit; the parity vector fixture
at test/fixtures/canonical-leaf-v24-vectors.json is the CI gate that
enforces this.

See the TypeScript module header for the version-bump discipline and the
rationale for promoting workflow_hash + machine_manifest_hash to
first-class leaf fields in v2.4.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Dict, Optional

LEAF_V24_FIELD_ORDER = (
    "tenant_id",
    "principal_id",
    "stream_id",
    "tenant_seq",
    "event_time",
    "payload_hash",
    "workflow_hash",
    "machine_manifest_hash",
    "dims",
)

CHAIN_HASH_ZERO_V24 = "0" * 64


def canonical_leaf_v24(
    *,
    tenant_id: str,
    stream_id: str,
    tenant_seq: int,
    event_time: str,
    payload_hash: str,
    principal_id: str = "",
    workflow_hash: str = "",
    machine_manifest_hash: str = "",
    dims: Optional[Dict[str, str]] = None,
) -> str:
    """Return the canonical UTF-8 preimage string for a v2.4 leaf."""
    dims = dims or {}
    sorted_dims: Dict[str, str] = {k: dims[k] for k in sorted(dims.keys())}
    payload: Dict[str, Any] = {
        "tenant_id": tenant_id,
        "principal_id": principal_id,
        "stream_id": stream_id,
        "tenant_seq": tenant_seq,
        "event_time": event_time,
        "payload_hash": payload_hash,
        "workflow_hash": workflow_hash,
        "machine_manifest_hash": machine_manifest_hash,
        "dims": sorted_dims,
    }
    return json.dumps(payload, separators=(",", ":"), ensure_ascii=False)


def leaf_hash_v24(**kwargs: Any) -> str:
    """Return lowercase 64-hex SHA-256 of the v2.4 canonical preimage."""
    preimage = canonical_leaf_v24(**kwargs)
    return hashlib.sha256(preimage.encode("utf-8")).hexdigest()


def chain_hash_v24(prev_chain_hash_hex: str, leaf_hash_hex: str) -> str:
    """Same semantics as v2.3 — chain hash function is not version-scoped."""
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
