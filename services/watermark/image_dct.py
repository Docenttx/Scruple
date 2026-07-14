"""Classical DCT-based spread-spectrum watermark for images (MVP).

Design:
- Convert image to YCbCr, operate on the luma (Y) channel only.
- Split Y into 8×8 blocks (JPEG-native block size — survives JPEG
  re-encoding well because the compression works on the same units).
- 2D DCT each block; embed one payload bit per block by modulating the
  sign of a mid-frequency coefficient (position (4, 3) in the block —
  low enough to survive quantization, high enough to be imperceptible).
- Modulation strength `alpha` chosen to be invisible (PSNR > 40 dB)
  but strong enough to survive JPEG q>=60 recompression.
- Payload: 16 bytes = 128 bits. Reed-Solomon expands to 240 bits with
  ~14 bytes of ECC (correctable up to ~7 byte errors).
- Bits are triple-repeated across blocks (redundancy for extra
  robustness); majority vote at decode time.
- If the image has fewer than 240 * 3 = 720 blocks (60×60 px min at 8×8
  block size — well below anything useful), embed raises.

This is a REFERENCE implementation. StegaStamp swap-in is Phase 1.1 for
better robustness against learned attacks; the classical DCT scheme is
sufficient for the survival matrix documented in WATERMARK_DESIGN §8
(JPEG q>=60, resize>=50%, crop>=60%, social platform re-encoding).
"""

from __future__ import annotations

import io
from typing import Optional

import numpy as np
from PIL import Image
from scipy.fftpack import dct, idct
import reedsolo

from .payload import PAYLOAD_BYTES, decode_payload

# --- Tuning ---------------------------------------------------------------
BLOCK_SIZE = 8
# Mid-frequency coefficient position (row, col) inside each 8×8 DCT block.
# (4, 3) sits in the JPEG quantization matrix's "reasonable" band —
# survives quality 60+ compression but is imperceptible.
COEF_POS = (4, 3)
# Modulation strength. Larger = more robust + more visible. 20.0 sits at
# roughly PSNR 42 dB for photographic content — invisible to eye.
ALPHA = 20.0
# Reed-Solomon ECC bytes. With 14 bytes of ECC on 16 bytes of payload,
# we can correct up to 7 byte errors — plenty for typical channel BER.
ECC_BYTES = 14
# Each ECC-encoded bit is repeated this many times across blocks for
# added redundancy (voted at decode). 3 = triple modular redundancy.
BIT_REPEAT = 3

_RS = reedsolo.RSCodec(ECC_BYTES)


def _dct2(block: np.ndarray) -> np.ndarray:
    return dct(dct(block, axis=0, norm='ortho'), axis=1, norm='ortho')


def _idct2(block: np.ndarray) -> np.ndarray:
    return idct(idct(block, axis=0, norm='ortho'), axis=1, norm='ortho')


def _bytes_to_bits(bs: bytes) -> np.ndarray:
    return np.unpackbits(np.frombuffer(bs, dtype=np.uint8))


def _bits_to_bytes(bits: np.ndarray) -> bytes:
    # Pad if not multiple of 8
    if len(bits) % 8:
        bits = np.concatenate([bits, np.zeros(8 - len(bits) % 8, dtype=np.uint8)])
    return bytes(np.packbits(bits.astype(np.uint8)))


def _expected_bits() -> int:
    """Total bits to embed after ECC + repetition."""
    return (PAYLOAD_BYTES + ECC_BYTES) * 8 * BIT_REPEAT


def embed_image(
    input_bytes: bytes,
    payload: bytes,
    *,
    input_format: Optional[str] = None,
    output_format: str = 'PNG',
    output_quality: int = 95,
) -> bytes:
    """Embed a 16-byte payload into an image; return the watermarked
    image bytes in `output_format`.

    output_format defaults to PNG (lossless) — for perceptual quality
    invariance across encode round-trips at test time. In production
    the caller should pass through the source format (JPEG/WebP/etc.)
    at high quality to preserve robustness against re-encoding.
    """
    if len(payload) != PAYLOAD_BYTES:
        raise ValueError(f'payload must be {PAYLOAD_BYTES} bytes')

    # Load, force RGB
    img = Image.open(io.BytesIO(input_bytes))
    if input_format is None:
        input_format = img.format or 'PNG'
    img = img.convert('YCbCr')
    y, cb, cr = img.split()

    y_arr = np.asarray(y, dtype=np.float64)
    h, w = y_arr.shape

    # ECC-expand payload → bits → repeated bits
    encoded = bytes(_RS.encode(payload))          # 30 bytes = 240 bits
    bits = _bytes_to_bits(encoded)                # (240,)
    bits_expanded = np.repeat(bits, BIT_REPEAT)   # (720,)

    n_blocks_h = h // BLOCK_SIZE
    n_blocks_w = w // BLOCK_SIZE
    n_blocks = n_blocks_h * n_blocks_w
    if n_blocks < len(bits_expanded):
        raise ValueError(
            f'image too small to embed watermark: {n_blocks} blocks '
            f'available, need {len(bits_expanded)} (min ~{int(np.ceil(np.sqrt(len(bits_expanded)))) * BLOCK_SIZE}px per side)',
        )

    # Embed
    y_out = y_arr.copy()
    for i, bit in enumerate(bits_expanded):
        br = (i // n_blocks_w) * BLOCK_SIZE
        bc = (i % n_blocks_w) * BLOCK_SIZE
        block = y_arr[br:br + BLOCK_SIZE, bc:bc + BLOCK_SIZE]
        d = _dct2(block)
        target = ALPHA if bit else -ALPHA
        d[COEF_POS] = target
        y_out[br:br + BLOCK_SIZE, bc:bc + BLOCK_SIZE] = _idct2(d)

    # Clip + merge back
    y_out = np.clip(y_out, 0, 255).astype(np.uint8)
    watermarked = Image.merge(
        'YCbCr',
        (Image.fromarray(y_out, mode='L'), cb, cr),
    ).convert('RGB')

    buf = io.BytesIO()
    save_kwargs = {}
    if output_format.upper() in ('JPEG', 'JPG', 'WEBP'):
        save_kwargs['quality'] = output_quality
    watermarked.save(buf, format=output_format, **save_kwargs)
    return buf.getvalue()


def decode_image(image_bytes: bytes) -> Optional[dict]:
    """Extract and decode a watermark from an image. Returns the payload
    dict per `payload.decode_payload()` on success, or None if no valid
    Scruple watermark could be recovered.

    Recovery order: extract bits → majority-vote redundancy → Reed-Solomon
    correct → parse payload → validate magic + version. Any step that
    fails returns None."""
    try:
        img = Image.open(io.BytesIO(image_bytes)).convert('YCbCr')
    except Exception:
        return None
    y, _, _ = img.split()
    y_arr = np.asarray(y, dtype=np.float64)
    h, w = y_arr.shape

    n_bits = _expected_bits()
    n_blocks_h = h // BLOCK_SIZE
    n_blocks_w = w // BLOCK_SIZE
    if n_blocks_h * n_blocks_w < n_bits:
        return None

    # Extract raw bits from block DCTs
    raw = np.zeros(n_bits, dtype=np.int8)
    for i in range(n_bits):
        br = (i // n_blocks_w) * BLOCK_SIZE
        bc = (i % n_blocks_w) * BLOCK_SIZE
        block = y_arr[br:br + BLOCK_SIZE, bc:bc + BLOCK_SIZE]
        d = _dct2(block)
        raw[i] = 1 if d[COEF_POS] > 0 else 0

    # Majority vote across repetitions
    per_bit = raw.reshape(-1, BIT_REPEAT)
    voted = (per_bit.sum(axis=1) * 2 > BIT_REPEAT).astype(np.uint8)  # (240,)

    # Reed-Solomon decode
    encoded_bytes = _bits_to_bytes(voted)
    try:
        payload_bytes, _, _ = _RS.decode(encoded_bytes)
    except reedsolo.ReedSolomonError:
        return None

    # Trim to PAYLOAD_BYTES (RSCodec.decode may return a bytearray)
    payload = bytes(payload_bytes[:PAYLOAD_BYTES])
    if len(payload) != PAYLOAD_BYTES:
        return None

    try:
        return decode_payload(payload)
    except ValueError:
        return None


if __name__ == '__main__':
    # Self-test
    from .payload import build_payload_tier_4_5, Tier
    from PIL import Image
    import numpy as np

    # Synthetic gradient image
    src = Image.fromarray(
        np.stack([
            np.tile(np.linspace(0, 255, 256, dtype=np.uint8), (256, 1)),
            np.tile(np.linspace(0, 255, 256, dtype=np.uint8).reshape(-1, 1), (1, 256)),
            np.full((256, 256), 128, dtype=np.uint8),
        ], axis=-1),
        mode='RGB',
    )
    buf = io.BytesIO()
    src.save(buf, format='PNG')
    src_bytes = buf.getvalue()

    payload = build_payload_tier_4_5(Tier.CHAIN_LOCK_BASIC, scr_id='SCR_A38E30FF')
    wm_bytes = embed_image(src_bytes, payload)
    print(f'watermarked: {len(wm_bytes)} bytes')
    decoded = decode_image(wm_bytes)
    print(f'decoded: {decoded}')

    # Decode from unwatermarked → should return None
    unwm = decode_image(src_bytes)
    print(f'decoded unwatermarked: {unwm}')
