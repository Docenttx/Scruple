"""Build a witness-ready payload from a file on disk.

Property 1 (CANON_SKELETON.md §5): MIME is declared, never guessed.
Blender hardcodes `application/octet-stream` for every upload; Meshroom
calls `mimetypes.guess_type()`, the exact extension-based auto-detect
GPSA v3 flagged for breaking `.flac` and `.jxl`; ToonBoom and both CAD
shells send `octet-stream` always, which silently gates the server's
image-only watermarker shut. `capture()` requires an explicit `mime` and
refuses without one -- there is no `mimetypes` import anywhere in this
package.

This module deliberately does NOT read host application state (no bpy
scene, no Meshroom chunk, no ToonBoom node). Blender's capture.py reads
`scene.render`, `bpy.data.materials`, `bpy.app.version` directly; that is
host-specific introspection and belongs in the adapter, per the host
hook contract in CANON_SKELETON.md §4 ("An adapter's entire job is
mapping its host's vocabulary onto these [hooks] and rendering native
UI"). The adapter builds its own `workflow` dict from whatever its host
exposes and hands it to `capture()` as data.
"""

from __future__ import annotations

import base64
import os
from typing import Any, Dict, Optional

from . import manifest as _manifest
from .errors import MimeRequiredError

CHUNK_SIZE = 1024 * 1024
INLINE_PAYLOAD_LIMIT_BYTES = 25 * 1024 * 1024


def sha256_file(path: str, chunk: int = CHUNK_SIZE) -> str:
    return _manifest.sha256_file(path, chunk)


def inline_base64(path: str) -> str:
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def require_mime(mime: Optional[str], *, caller: str = "capture()") -> str:
    """Property 1 (CANON_SKELETON.md §5), as ONE function.

    This is the single enforcement point for "MIME is declared, never
    guessed", and it lives in `scruple-api` rather than in the SDK on
    purpose. It has two call sites and they are on opposite sides of the
    API/SDK line:

      - `capture()` below, the real path;
      - `provider.NoOpWitnessRecorder.witness_file()`, the path taken by a
        vendor who has instrumented their code but has not installed or
        registered an SDK yet.

    If this check lived in the SDK, the second call site would not have it,
    and a vendor wiring Scruple into their Save handler during development
    would discover months later — at the moment the SDK is finally
    registered — that half their call sites never declared a MIME. The rule
    a consumer is held to must not depend on whether the consumer has our
    implementation installed.

    There is no `mimetypes` import anywhere in this package or in the SDK.
    """
    if mime is None or not mime.strip():
        raise MimeRequiredError(
            f"{caller} requires an explicit `mime`. Do not derive it from "
            "the file extension and do not default to "
            "application/octet-stream -- the caller wrote this file and "
            "knows what it is; the SDK does not guess."
        )
    return mime.strip()


def capture(
    path: str,
    *,
    mime: str,
    kind: str,
    workflow: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Hash and inline-encode `path`, ready for witness_flow.witness().

    Raises MimeRequiredError if `mime` is missing, empty, or whitespace.
    Raises FileNotFoundError if `path` does not exist. Raises ValueError
    if the file exceeds the inline-payload limit -- callers with larger
    assets should hash out-of-band and call witness_flow.witness()
    directly with the resulting content_hash rather than routing bytes
    through this function.
    """
    declared_mime = require_mime(mime, caller="capture()")
    if not path or not os.path.exists(path):
        raise FileNotFoundError(f"capture(): no file at {path!r}")

    size = os.path.getsize(path)
    if size > INLINE_PAYLOAD_LIMIT_BYTES:
        raise ValueError(
            f"capture(): {path} is {size} bytes, over the "
            f"{INLINE_PAYLOAD_LIMIT_BYTES}-byte inline limit."
        )

    digest = sha256_file(path)
    return {
        "path": path,
        "filename": os.path.basename(path),
        "mime": declared_mime,
        "kind": kind,
        "content_hash": digest,
        "inline_base64": inline_base64(path),
        "workflow": dict(workflow) if workflow else {},
    }
