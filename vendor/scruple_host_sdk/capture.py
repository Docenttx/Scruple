"""Re-export of capture + the MIME gate, which live in `scruple-api`.

Property 1 (MIME is declared, never guessed) is enforced by
`scruple_api.capture.require_mime()`, which `capture()` calls on the real
path and `scruple_api.provider.NoOpWitnessRecorder.witness_file()` calls
when no SDK is registered. It is one function with two call sites on
opposite sides of the API/SDK line, which is what keeps the property true
for a consumer who has only vendored the API.

There is still no `mimetypes` import in either package.

See `scruple_api/capture.py`.
"""

from __future__ import annotations

from scruple_api.capture import (
    CHUNK_SIZE,
    INLINE_PAYLOAD_LIMIT_BYTES,
    capture,
    inline_base64,
    require_mime,
    sha256_file,
)

__all__ = [
    "CHUNK_SIZE",
    "INLINE_PAYLOAD_LIMIT_BYTES",
    "capture",
    "inline_base64",
    "require_mime",
    "sha256_file",
]
