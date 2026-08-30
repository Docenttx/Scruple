"""Re-export of canonical JSON + the tamper-surface hash, which live in
`scruple-api`.

Moved there because a tamper-surface hash is computed over the
integration's own code and configuration and needs nothing but `hashlib`,
`json` and `pathlib` -- and because a vendor preparing a baseline should
be able to compute and inspect the hash they are about to be held to
without installing anything that can reach us.

See `scruple_api/manifest.py`.
"""

from __future__ import annotations

from scruple_api.manifest import (
    build_machine_manifest,
    canonicalize,
    compute_tamper_surface_hash,
    machine_manifest_hash,
    sha256_file,
    sha256_hex,
)

__all__ = [
    "canonicalize",
    "sha256_hex",
    "sha256_file",
    "build_machine_manifest",
    "machine_manifest_hash",
    "compute_tamper_surface_hash",
]
