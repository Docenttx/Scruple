"""Canonical JSON serialization. Byte-stable across runs and languages.

Matches the TypeScript canonicalize implementation in
lib/baseline/ingest_check.ts and packages/scruple-attestation-verifiers/
src/envelope.ts. Verified via parity fixtures.
"""

from __future__ import annotations

import json
from typing import Any


def canonicalize(obj: Any) -> str:
    """Deterministic JSON: sorted keys, compact, no whitespace.

    Arrays preserve their input order (do NOT sort). Numbers are emitted
    as JSON numbers via json.dumps. Strings are JSON-escaped. Booleans
    and null follow JSON conventions.
    """
    if obj is None:
        return "null"
    if isinstance(obj, bool):
        return "true" if obj else "false"
    if isinstance(obj, (int, float)):
        # json.dumps handles the number formatting deterministically
        return json.dumps(obj)
    if isinstance(obj, str):
        return json.dumps(obj)
    if isinstance(obj, (list, tuple)):
        return "[" + ",".join(canonicalize(x) for x in obj) + "]"
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        parts = [json.dumps(str(k)) + ":" + canonicalize(obj[k]) for k in keys]
        return "{" + ",".join(parts) + "}"
    raise TypeError(f"cannot canonicalize {type(obj).__name__}")
