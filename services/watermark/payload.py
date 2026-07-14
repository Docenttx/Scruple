"""Payload structure per WATERMARK_DESIGN_v1.md v1.2 §3.

Bit layout:
    | offset | bits | field              |
    |--------|------|--------------------|
    |   0    |   8  | magic (0x5C)       |
    |   8    |   4  | version (v1..v15)  |
    |  12    |   4  | tier (0..15)       |
    |  16    | 112  | tier-specific body |

Tier body layouts:
    tier 1/2/3: [ signed_at_unix_seconds: 64 bits ] [ reserved: 48 bits ]
    tier 4:     [ scr_id: 64 bits ] [ reserved: 48 bits ]
    tier 5:     [ scr_id: 64 bits ] [ pinned_hint: 48 bits ]

Total: 128 bits (16 bytes). ECC layer added on top by the media-specific
encoders — this module only handles the payload packing/unpacking.

Reference test vectors at services/watermark/tests/test_payload.py.
"""

from __future__ import annotations

import time
from enum import IntEnum
from typing import Optional

MAGIC = 0x5C
VERSION_V1 = 0x1
PAYLOAD_BYTES = 16   # 128 bits


class Tier(IntEnum):
    """Payload tier values per §3.1 of the design doc."""
    RESERVED_0 = 0
    C2PA_SIGNED = 1
    CHECKPOINT = 2
    LOCAL_LOCK = 3
    CHAIN_LOCK_BASIC = 4
    CHAIN_LOCK_PINNED = 5


def _pack_header(version: int, tier: int) -> int:
    """Pack the 16-bit header: magic(8) + version(4) + tier(4)."""
    if not (0 <= version <= 0xF):
        raise ValueError(f'version out of range: {version}')
    if not (0 <= tier <= 0xF):
        raise ValueError(f'tier out of range: {tier}')
    return (MAGIC << 8) | (version << 4) | tier


def _scr_id_to_u64(scr_id: str) -> int:
    """Convert 'SCR_ABCDEF' or 'SCR_ABCDEF12' to a u64.

    SCR-IDs are 6-8 hex chars after the 'SCR_' prefix, right-padded with
    zeros to fit 64 bits. Bare SCR ID with no prefix also accepted for
    convenience."""
    s = scr_id
    if s.startswith('SCR_'):
        s = s[4:]
    elif s.startswith('SCRB_'):
        s = s[5:]  # backup-scheme SCR-ID variant
    if not (6 <= len(s) <= 16):
        raise ValueError(f'scr_id hex portion must be 6-16 chars, got {len(s)}: {scr_id}')
    if any(c not in '0123456789abcdefABCDEF' for c in s):
        raise ValueError(f'scr_id must be hex, got: {scr_id}')
    # Right-pad with zeros so short IDs live in the high bits (easy to
    # read visually when hex-dumping the payload).
    s_padded = (s + '0' * 16)[:16]
    return int(s_padded, 16)


def _u64_to_scr_id(value: int, digits: int = 8) -> str:
    """Convert a u64 back to 'SCR_XXXXXXXX' form. Strips trailing zeros
    from the padding, minimum `digits` hex chars retained."""
    h = f'{value:016x}'
    # Strip trailing zeros but keep at least `digits` chars.
    stripped = h.rstrip('0')
    if len(stripped) < digits:
        stripped = h[:digits]
    return f'SCR_{stripped.upper()}'


def build_payload_tier_1_3(
    tier: Tier,
    signed_at_unix_seconds: Optional[int] = None,
) -> bytes:
    """Pack a tier 1/2/3 payload. Body: 64-bit timestamp + 48-bit reserved.

    signed_at_unix_seconds defaults to the current UTC time. Callers who
    need reproducibility should pass an explicit value.
    """
    if tier not in (Tier.C2PA_SIGNED, Tier.CHECKPOINT, Tier.LOCAL_LOCK):
        raise ValueError(f'tier must be 1/2/3 for this builder, got {tier!r}')
    if signed_at_unix_seconds is None:
        signed_at_unix_seconds = int(time.time())
    if not (0 <= signed_at_unix_seconds < (1 << 64)):
        raise ValueError(f'signed_at_unix_seconds out of u64 range: {signed_at_unix_seconds}')

    header = _pack_header(VERSION_V1, tier.value)
    body = (signed_at_unix_seconds << 48).to_bytes(14, 'big')
    return header.to_bytes(2, 'big') + body


def build_payload_tier_4_5(
    tier: Tier,
    scr_id: str,
    pinned_hint: Optional[int] = None,
) -> bytes:
    """Pack a tier 4/5 payload. Body: 64-bit SCR_ID + 48-bit hint.

    For tier 4 (chain-lock basic), pinned_hint MUST be None or 0.
    For tier 5 (chain-lock pinned), pinned_hint is a caller-computed
    48-bit lookup key derived from the IPFS CID + Arweave txid on file.
    """
    if tier not in (Tier.CHAIN_LOCK_BASIC, Tier.CHAIN_LOCK_PINNED):
        raise ValueError(f'tier must be 4/5 for this builder, got {tier!r}')
    if tier == Tier.CHAIN_LOCK_BASIC and pinned_hint not in (None, 0):
        raise ValueError('tier 4 must not carry a pinned_hint')
    if tier == Tier.CHAIN_LOCK_PINNED and pinned_hint is None:
        raise ValueError('tier 5 requires a pinned_hint')

    scr_id_u64 = _scr_id_to_u64(scr_id)
    hint = pinned_hint or 0
    if not (0 <= hint < (1 << 48)):
        raise ValueError(f'pinned_hint out of 48-bit range: {hint}')

    header = _pack_header(VERSION_V1, tier.value)
    body_int = (scr_id_u64 << 48) | hint
    body = body_int.to_bytes(14, 'big')
    return header.to_bytes(2, 'big') + body


def decode_payload(payload: bytes) -> dict:
    """Decode a 16-byte payload. Returns a dict with the decoded fields
    or raises ValueError if the magic/version doesn't match.

    Callers should treat a raised ValueError as "no scruple watermark"
    per §3.2 of the design doc — return the negative verdict, don't
    propagate."""
    if len(payload) != PAYLOAD_BYTES:
        raise ValueError(f'payload must be {PAYLOAD_BYTES} bytes, got {len(payload)}')

    magic = payload[0]
    if magic != MAGIC:
        raise ValueError(f'wrong magic: 0x{magic:02x} (expected 0x{MAGIC:02x})')

    version = (payload[1] >> 4) & 0xF
    tier = payload[1] & 0xF
    if version != VERSION_V1:
        raise ValueError(f'unsupported version: {version}')

    body_bytes = payload[2:]
    body_int = int.from_bytes(body_bytes, 'big')

    result = {
        'magic': magic,
        'version': version,
        'tier': tier,
    }

    if tier in (Tier.C2PA_SIGNED, Tier.CHECKPOINT, Tier.LOCAL_LOCK):
        signed_at = (body_int >> 48) & ((1 << 64) - 1)
        reserved = body_int & ((1 << 48) - 1)
        result['tier_name'] = Tier(tier).name
        result['signed_at_unix_seconds'] = signed_at
        result['reserved'] = reserved
    elif tier in (Tier.CHAIN_LOCK_BASIC, Tier.CHAIN_LOCK_PINNED):
        scr_id_u64 = (body_int >> 48) & ((1 << 64) - 1)
        hint = body_int & ((1 << 48) - 1)
        result['tier_name'] = Tier(tier).name
        result['scr_id'] = _u64_to_scr_id(scr_id_u64)
        result['scr_id_u64'] = scr_id_u64
        result['pinned_hint'] = hint if tier == Tier.CHAIN_LOCK_PINNED else None
    else:
        result['tier_name'] = f'reserved_{tier}'
        result['body_raw_hex'] = body_bytes.hex()

    return result


def payload_hex(payload: bytes) -> str:
    """Standard hex representation used in the API (32 chars)."""
    return payload.hex()


def payload_from_hex(hex_str: str) -> bytes:
    """Parse the standard hex representation."""
    if len(hex_str) != PAYLOAD_BYTES * 2:
        raise ValueError(f'payload hex must be {PAYLOAD_BYTES * 2} chars, got {len(hex_str)}')
    return bytes.fromhex(hex_str)


if __name__ == '__main__':
    # Quick self-test
    p1 = build_payload_tier_1_3(Tier.C2PA_SIGNED, signed_at_unix_seconds=1720974000)
    print(f'tier1: {payload_hex(p1)}  → {decode_payload(p1)}')
    p4 = build_payload_tier_4_5(Tier.CHAIN_LOCK_BASIC, scr_id='SCR_A38E30FF')
    print(f'tier4: {payload_hex(p4)}  → {decode_payload(p4)}')
    p5 = build_payload_tier_4_5(Tier.CHAIN_LOCK_PINNED, scr_id='SCR_ABCDEF', pinned_hint=0xDEADBEEFCAFE)
    print(f'tier5: {payload_hex(p5)}  → {decode_payload(p5)}')
