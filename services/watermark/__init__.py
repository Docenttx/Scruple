"""Scruple imperceptible watermark — reference implementation.

Per WATERMARK_DESIGN_v1.md v1.2:
- Publication-time layer (never applied at generation)
- Client-side payload construction (no server round-trip)
- 128-bit payload structure: magic(8) + version(4) + tier(4) + body(112)
- Tier 1-3 body: signed_at_unix_seconds(64) + reserved(48)
- Tier 4-5 body: scr_id(64) + [reserved/pinned_hint](48)
- Public lookup only for tier 4-5 (RVN chain); tier 1-3 self-contained

MVP encoder is a classical DCT-based scheme (Cox et al. spread-spectrum
in the mid-frequency DCT coefficients). Chosen over StegaStamp for the
first ship because it has zero ML dependency, ~200 lines of NumPy, and
adequate robustness for the survival targets in the design doc (JPEG
q>=60, resize>=50%, crop>=60%, social platform re-encoding). StegaStamp
swap-in is Phase 1.1 — same PublicAPI, deeper model dep.

Public API:
    from scruple_watermark import (
        build_payload_tier_1_3, build_payload_tier_4_5,
        embed_image, decode_image,
    )
"""

from .payload import (
    MAGIC,
    VERSION_V1,
    Tier,
    build_payload_tier_1_3,
    build_payload_tier_4_5,
    decode_payload,
)
from .image_dct import embed_image, decode_image

__all__ = [
    'MAGIC', 'VERSION_V1', 'Tier',
    'build_payload_tier_1_3', 'build_payload_tier_4_5',
    'decode_payload', 'embed_image', 'decode_image',
]
