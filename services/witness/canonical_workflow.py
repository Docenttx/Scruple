"""Canonical serialization for ComfyUI workflow_api_json — Python twin.

Byte-for-byte parity with lib/scruple/canonicalWorkflow.ts. Any change to
one MUST land in the other.

Rule: recursively sort object keys alphabetically; preserve array order;
no whitespace between separators.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any


def canonicalize(value: Any) -> str:
    """Canonicalize any JSON-serializable value with stable, recursive key
    ordering. Arrays preserve order.
    """
    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
    )


def hash_workflow(workflow_api_json: Any) -> str:
    """SHA-256 hex of the canonical serialization of a ComfyUI workflow.
    Returns 64 lowercase hex chars, no `sha256:` prefix.
    """
    return hashlib.sha256(
        canonicalize(workflow_api_json).encode("utf-8"),
    ).hexdigest()
