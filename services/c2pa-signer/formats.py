"""Canonical registry of the C2PA formats Scruple can actually handle.

ONE TABLE. Everything else in this file is derived from it, and the
TypeScript twin (`lib/c2pa/formats.ts`) mirrors it entry for entry.

WHY THE TABLE, AND WHY IT IS DERIVED

Until 2026-09-02 four lists disagreed about what Scruple signs:

  - `lib/c2pa/signAsset.ts` `mimeFromPath` mapped `.webm` to `video/webm`
    and handed it to a signer with no WebM handler, so a txt2vid WebM got
    a 500 from `/api/scruple/c2pa/sign` rather than "unsupported"
  - `GENERATE_MIMES` here asserted `application/x-pytorch` on the
    Conformance Intake Form; c2pa-rs refuses it outright
  - `GENERATE_MIMES` listed `video/x-msvideo` as validate-only although
    AVI signs to `validation_state=Valid`, and omitted GIF and JXL, which
    also sign
  - `lib/v2/capabilities.ts` advertised `image/vnd.adobe.photoshop`,
    which no version of this stack has ever been able to sign

Three of the four were advertising a capability the library does not
have; the fourth was hiding one it does. All four were hand-maintained
copies of the same fact.

MEASURED, NOT ASSERTED

Every `generate=True` row below was signed on 2026-09-02 through
`c2pa-python 0.36.0` against the real fixture in
`docs/c2pa-conformance-evidence/2026-07-14/Raw.input.<mime>/` and read
back through `c2pa.Reader` to `validation_state=Valid`. 18 of 18.
`tests/test_format_support.py` re-runs exactly that and fails if a
claimed MIME stops round-tripping — the drift guard the 07-14 bundle
never had.

`UNSUPPORTED` is the must-NOT-fire half. c2pa-rs answers a MIME it has
no handler for with the distinctive `Builder does not support <mime>` /
`Reader does not support <mime>`, which is how each row was confirmed. A
green list with no control proves only that it cannot fail.

WHEN THE INTAKE FORM AND THE LIBRARY DISAGREE

The Intake Form is a claim to a standards body; this file is what the
code can do. Where they diverge, this file follows the library and the
divergence is recorded in `INTAKE_ASSERTED_NOT_SUPPORTED` rather than
quietly dropped — the 2026-07-14 bundle already shipped
`NOT_SUPPORTED.txt` for both entries, so the gap is on the record with
the reviewer and must not be re-asserted here.

C2PA-Conformance-Program record ID: 019f5856-bff8-7f57-a879-80594a6fb3fe
"""

from __future__ import annotations

from typing import NamedTuple


class Format(NamedTuple):
    mime: str
    #: Lower-case, dot-prefixed. First entry is canonical for this MIME.
    extensions: tuple[str, ...]
    #: We PRODUCE signed manifests in this format.
    generate: bool
    #: We INGEST manifests as ingredients in this format.
    validate: bool


class Unsupported(NamedTuple):
    mime: str
    extensions: tuple[str, ...]
    reason: str


# ── The table ─────────────────────────────────────────────────────────
# Order is the evidence-bundle ordering: the fifteen formats the
# 2026-07-14 bundle generated, in their original order so existing seed
# indices do not shift, then the three that were signable all along and
# were never claimed, then the validate-only entries.
FORMATS: tuple[Format, ...] = (
    Format('image/jpeg',        ('.jpg', '.jpeg'), True, True),
    Format('image/png',         ('.png',),         True, True),
    Format('image/svg+xml',     ('.svg',),         True, True),
    Format('image/x-adobe-dng', ('.dng',),         True, True),
    Format('image/tiff',        ('.tiff', '.tif'), True, True),
    Format('image/webp',        ('.webp',),        True, True),
    Format('image/heic',        ('.heic',),        True, True),
    Format('image/heif',        ('.heif',),        True, True),
    Format('image/avif',        ('.avif',),        True, True),
    Format('video/mp4',         ('.mp4',),         True, True),
    Format('video/quicktime',   ('.mov',),         True, True),
    Format('audio/flac',        ('.flac',),        True, True),
    Format('audio/mpeg',        ('.mp3',),         True, True),
    Format('audio/wav',         ('.wav',),         True, True),
    Format('audio/mp4',         ('.m4a',),         True, True),

    # Signed to validation_state=Valid on 2026-09-02 and claimed by
    # lib/v2/capabilities.ts since it was written. GENERATE_MIMES was the
    # list that was wrong, not the advertisement.
    Format('image/gif',         ('.gif',),         True, True),
    Format('image/jxl',         ('.jxl',),         True, True),
    Format('video/x-msvideo',   ('.avi',),         True, True),

    # Reader has a PDF handler; Builder does not. Validate-only is the
    # honest claim, and the 07-14 bundle already says so.
    Format('application/pdf',   ('.pdf',),         False, True),
)

# ── The must-NOT-fire half ────────────────────────────────────────────
# A MIME here is REFUSED before the signer subprocess is spawned. The
# refusal names the ceiling, because "unsupported" with no reason reads
# as a bug and sends the reader looking in our config for a fault that
# is in the library.
UNSUPPORTED: tuple[Unsupported, ...] = (
    Unsupported(
        'video/webm', ('.webm',),
        'c2pa-rs 0.36.0 has no WebM handler — the Builder answers '
        '"Builder does not support video/webm". Transcode to MP4 '
        '(video/mp4) or MOV (video/quicktime), both of which sign.',
    ),
    Unsupported(
        'image/vnd.adobe.photoshop', ('.psd',),
        'c2pa-rs 0.36.0 has no PSD handler. Export a PNG, TIFF or JPEG '
        'and sign that.',
    ),
    Unsupported(
        'application/x-pytorch', ('.pt', '.pth'),
        'c2pa-rs 0.36.0 has no embedded-manifest handler for model '
        'checkpoints. A checkpoint is bound by an EXTERNAL (sidecar) '
        'manifest instead — see scripts/puffjuly12/12-emit-lora-sidecar.py.',
    ),
    Unsupported(
        'application/octet-stream', (),
        'application/octet-stream is not a format, it is the absence of '
        'one. Declare the real MIME.',
    ),
)

# Formats the Conformance Intake Form asserts that this stack cannot
# deliver, kept visible rather than deleted. Both already shipped a
# NOT_SUPPORTED.txt in docs/c2pa-conformance-evidence/2026-07-14/, so
# the reviewer has them; re-asserting them here would be the overclaim.
INTAKE_ASSERTED_NOT_SUPPORTED = {
    'application/x-pytorch': 'generate + validate — no c2pa-rs handler',
    'application/pdf': 'generate only — Reader has a handler, Builder does not',
}

# ── Derived. Do not hand-maintain. ────────────────────────────────────
GENERATE_MIMES = [f.mime for f in FORMATS if f.generate]
VALIDATE_MIMES = [f.mime for f in FORMATS if f.validate]
ALL_MIMES = sorted({f.mime for f in FORMATS})
UNSUPPORTED_MIMES = {u.mime: u.reason for u in UNSUPPORTED}

#: extension → MIME, covering supported AND unsupported formats. An
#: unsupported extension still resolves to its true MIME so the refusal
#: can name it; see `refusal_reason`.
EXTENSION_TO_MIME = {
    **{ext: f.mime for f in FORMATS for ext in f.extensions},
    **{ext: u.mime for u in UNSUPPORTED for ext in u.extensions},
}


def mime_from_path(path: str) -> str:
    """Extension → MIME. Unknown extensions get octet-stream, which is
    itself an UNSUPPORTED entry, so the caller gets a named refusal
    rather than a subprocess crash."""
    import os
    _, ext = os.path.splitext(path)
    return EXTENSION_TO_MIME.get(ext.lower(), 'application/octet-stream')


def refusal_reason(mime: str) -> str | None:
    """None when `mime` can be signed. Otherwise the reason, ready to
    return to a caller."""
    m = mime.lower().split(';')[0].strip()
    if m in GENERATE_MIMES:
        return None
    if m in UNSUPPORTED_MIMES:
        return f'{m} cannot be signed: {UNSUPPORTED_MIMES[m]}'
    return (
        f'{m} is not a format Scruple is asserted as a C2PA Generator '
        f'Product for. Signable: {", ".join(GENERATE_MIMES)}.'
    )


# c2pa product identity — used in every signed manifest's
# claim_generator_info block. Version bumps require re-submitting the
# Conformance Intake Form.
CLAIM_GENERATOR = {'name': 'Scruple', 'version': '0.1'}
