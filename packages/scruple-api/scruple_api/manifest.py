"""Canonical JSON + the tamper-surface hash that baselines are keyed by.

`canonicalize` / `sha256_hex` are a near-verbatim port of Blender's
manifest.py -- sorted-keys, no-whitespace JSON, matching what the server
computes so a hash produced here and a hash produced server-side agree
byte-for-byte.

`compute_tamper_surface_hash` is new: none of the six forks ever called
POST /baseline (D-3 -- "not one integration establishes a baseline"), so
there was nothing to port for it. It hashes over the integration's own
code and configuration, not the host application's -- Standard §4 asks
what changed about the *integration*, not about the user's project.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


def canonicalize(obj: Any) -> str:
    """Sorted-keys, no-whitespace JSON. Byte-for-byte matches the server."""
    if isinstance(obj, dict):
        keys = sorted(obj.keys())
        return "{" + ",".join(json.dumps(k) + ":" + canonicalize(obj[k]) for k in keys) + "}"
    if isinstance(obj, list):
        return "[" + ",".join(canonicalize(v) for v in obj) + "]"
    return json.dumps(obj)


def sha256_hex(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def sha256_file(path: str, chunk: int = 1024 * 1024) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            buf = f.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def build_machine_manifest(
    *,
    host: str,
    integration_version: str,
    host_version: Optional[str] = None,
    sdk_version: str = "0.1.0",
    extra: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Kept host-agnostic on purpose -- Blender's build_machine_manifest
    hardcoded blender_version/addon; scene-specific fields like that
    belong in the adapter's `workflow` dict (capture.capture()'s
    `workflow` argument), not here. This is the part every host shares."""
    m: Dict[str, Any] = {
        "host": host,
        "integration_version": integration_version,
        "sdk": "scruple-host-sdk",
        "sdk_version": sdk_version,
    }
    if host_version:
        m["host_version"] = host_version
    if extra:
        m.update(extra)
    return m


def machine_manifest_hash(manifest: Dict[str, Any]) -> str:
    return sha256_hex(canonicalize(manifest))


def compute_tamper_surface_hash(
    *,
    integration_version: str,
    config: Optional[Dict[str, Any]] = None,
    code_paths: Optional[Iterable[str]] = None,
) -> str:
    """Hash over the integration's code/config -- the surface D-3/§4 says
    must not change silently.

    `code_paths` are files or directories that identify *this build* of
    the adapter (typically the adapter's own .py sources, not the host
    application's, and never the user's project files). Directories are
    walked for `*.py` files, sorted for determinism. A path that does
    not exist is recorded as "MISSING" rather than skipped -- its
    absence is itself tamper-relevant, not a reason to silently shrink
    the surface being measured. A file that exists but cannot be read is
    recorded as "UNREADABLE:<reason>" for the same reason.
    """
    files: Dict[str, str] = {}
    for root in sorted(code_paths or []):
        p = Path(root)
        if p.is_file():
            candidates = [p]
        elif p.is_dir():
            candidates = sorted(q for q in p.rglob("*.py") if q.is_file())
        else:
            files[str(p)] = "MISSING"
            continue
        for f in candidates:
            try:
                files[str(f)] = sha256_file(str(f))
            except OSError as e:
                files[str(f)] = f"UNREADABLE:{e}"

    payload = {
        "integration_version": integration_version,
        "config": config or {},
        "files": files,
    }
    return sha256_hex(canonicalize(payload))
