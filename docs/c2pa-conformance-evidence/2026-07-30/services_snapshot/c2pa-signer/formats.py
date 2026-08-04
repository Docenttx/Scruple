"""Canonical registry of the C2PA formats Scruple asserts on the
Conformance Intake Form.

Mirrors the Intake Form's "generate" and "validate" sections. When the
intake asserts a format, this file must list it, and the corresponding
producers.py entry + signer round-trip must actually work.

Kept small + declarative so the evidence bundle builder + audit script
share one source of truth.

C2PA-Conformance-Program record ID: 019f5856-bff8-7f57-a879-80594a6fb3fe
"""

# ── Generator-side (we PRODUCE signed manifests in these formats) ──────
# Every entry MUST have a producers.PRODUCERS[mime] entry.
GENERATE_MIMES = [
    'image/jpeg',
    'image/png',
    'image/svg+xml',
    'image/x-adobe-dng',
    'image/tiff',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/avif',
    'video/mp4',
    'video/quicktime',
    'audio/flac',
    'audio/mpeg',
    'audio/wav',
    'audio/mp4',
    'application/x-pytorch',  # intake asserted "pytorch" → c2pa MIME
]

# ── Validator-side (we INGEST manifests as ingredients in these formats) ─
# Superset of GENERATE — plus JXL, GIF, AVI, PDF.
VALIDATE_MIMES = [
    'image/jpeg',
    'image/jxl',
    'image/png',
    'image/svg+xml',
    'image/gif',
    'image/x-adobe-dng',
    'image/tiff',
    'image/webp',
    'image/heic',
    'image/heif',
    'image/avif',
    'video/x-msvideo',
    'video/mp4',
    'video/quicktime',
    'audio/flac',
    'audio/mpeg',
    'audio/wav',
    'audio/mp4',
    'application/pdf',
    'application/x-pytorch',
]

# Convenience: everything we touch, either side
ALL_MIMES = sorted(set(GENERATE_MIMES) | set(VALIDATE_MIMES))

# c2pa product identity — used in every signed manifest's
# claim_generator_info block. Version bumps require re-submitting the
# Conformance Intake Form.
CLAIM_GENERATOR = {'name': 'Scruple', 'version': '0.1'}
