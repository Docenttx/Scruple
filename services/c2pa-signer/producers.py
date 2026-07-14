"""Deterministic media producers for every asserted C2PA format.

Used by:
  - build_evidence_bundle.py — generate raw + signed samples for
    C2PA Conformance Program submission
  - E2E tests that need a real file of a given MIME type without
    reaching for external assets

Every producer takes a seed (int) and returns raw bytes. Same seed →
byte-identical output, so evidence bundles are reproducible.

Coverage matches services/c2pa-signer/formats.py FORMATS list.
"""

from __future__ import annotations

import io
import os
import subprocess
import tempfile
from typing import Callable, Dict

import numpy as np
from PIL import Image
import pillow_heif
import pillow_avif  # registers AVIF plugin  # noqa: F401
import soundfile as sf
import imageio.v3 as iio
from jxlpy import JXLPyEncoder

pillow_heif.register_heif_opener()

DEFAULT_W, DEFAULT_H = 64, 64
DEFAULT_SR = 8000  # audio sample rate — small but valid


# ── Image producers ────────────────────────────────────────────────────

def _gradient_rgb(seed: int, w: int = DEFAULT_W, h: int = DEFAULT_H) -> Image.Image:
    """Deterministic RGB gradient keyed by seed. Small (64×64) to keep
    evidence bundle small; the point is validity + verifiability."""
    rng = np.random.default_rng(seed)
    r = np.linspace(0, 255, w, dtype=np.uint8)
    g = np.linspace(0, 255, h, dtype=np.uint8)
    R, G = np.meshgrid(r, g)
    B = np.full_like(R, rng.integers(0, 256))
    arr = np.stack([R, G, B], axis=-1).astype(np.uint8)
    return Image.fromarray(arr, mode='RGB')


def _pil_save(seed: int, fmt: str, **kwargs) -> bytes:
    img = _gradient_rgb(seed)
    buf = io.BytesIO()
    img.save(buf, format=fmt, **kwargs)
    return buf.getvalue()


def make_png(seed: int) -> bytes:   return _pil_save(seed, 'PNG', optimize=True)
def make_jpeg(seed: int) -> bytes:  return _pil_save(seed, 'JPEG', quality=90)
def make_webp(seed: int) -> bytes:  return _pil_save(seed, 'WEBP', quality=90)
def make_tiff(seed: int) -> bytes:  return _pil_save(seed, 'TIFF', compression='tiff_lzw')
def make_gif(seed: int) -> bytes:   return _pil_save(seed, 'GIF')


def make_svg(seed: int) -> bytes:
    """SVG is text — build a valid <svg> with a rect whose fill is seed-derived."""
    rng = np.random.default_rng(seed)
    r, g, b = rng.integers(0, 256, size=3)
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>\n'
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{DEFAULT_W}" height="{DEFAULT_H}" '
        f'viewBox="0 0 {DEFAULT_W} {DEFAULT_H}">\n'
        f'  <rect width="100%" height="100%" fill="rgb({r},{g},{b})"/>\n'
        f'  <text x="4" y="16" font-family="monospace" font-size="10" fill="white">'
        f'scruple-seed-{seed}</text>\n'
        f'</svg>\n'
    ).encode('utf-8')


def make_heif(seed: int) -> bytes:
    return _pil_save(seed, 'HEIF', quality=90)


def make_heic(seed: int) -> bytes:
    # HEIC is the same container as HEIF; libheif serializes the same
    # bytes regardless of extension. Some readers dispatch on ext, so
    # writing via imageio with .heic ensures a valid file for tools that
    # do sniff by extension.
    return iio.imwrite('<bytes>', np.array(_gradient_rgb(seed)), extension='.heic')


def make_avif(seed: int) -> bytes:
    return _pil_save(seed, 'AVIF', quality=90)


def make_jxl(seed: int) -> bytes:
    """JPEG XL via jxlpy. Frames are added as raw bytes and finalized."""
    img = _gradient_rgb(seed)
    enc = JXLPyEncoder(quality=90, colorspace='RGB', size=img.size, num_threads=1)
    enc.add_frame(bytes(np.array(img)))
    out = enc.get_output()
    enc.close()
    return out


def make_dng(seed: int) -> bytes:
    """DNG is a subset of TIFF with DNG-specific tags. We produce a
    valid uncompressed TIFF and inject the DNGVersion tag; c2pa-rs
    parses this as DNG format. This is not a photorealistic camera-
    original DNG but IS a valid DNG file structure that our signer
    round-trips through the DNG code path."""
    img = _gradient_rgb(seed)
    buf = io.BytesIO()
    from PIL.TiffImagePlugin import ImageFileDirectory_v2
    ifd = ImageFileDirectory_v2()
    # DNGVersion (tag 50706): 4 bytes major.minor.patch.build. 1.4.0.0 → recent.
    ifd[50706] = b'\x01\x04\x00\x00'
    # DNGBackwardVersion (tag 50707): earliest compat version → 1.0.0.0
    ifd[50707] = b'\x01\x00\x00\x00'
    # UniqueCameraModel (tag 50708) — required field per DNG spec
    ifd[50708] = f'Scruple synthetic seed-{seed}'
    img.save(buf, format='TIFF', tiffinfo=ifd, compression='raw')
    return buf.getvalue()


# ── Video producers (ffmpeg) ───────────────────────────────────────────

def _ffmpeg_video(seed: int, ext: str, codec: str, **extra) -> bytes:
    """1-second 64x64 solid color at 24fps, color derived from seed.
    Encoded to `ext` (mp4/mov/avi) with `codec`."""
    rng = np.random.default_rng(seed)
    r, g, b = rng.integers(0, 256, size=3)
    color_hex = f'0x{r:02X}{g:02X}{b:02X}'
    with tempfile.NamedTemporaryFile(suffix='.' + ext, delete=False) as tf:
        out_path = tf.name
    try:
        cmd = [
            'ffmpeg', '-y',
            '-f', 'lavfi',
            '-i', f'color=c={color_hex}:s={DEFAULT_W}x{DEFAULT_H}:d=1:r=24',
            '-c:v', codec,
        ]
        if codec == 'libx264':
            cmd += ['-pix_fmt', 'yuv420p', '-preset', 'ultrafast']
        for k, v in extra.items():
            cmd += [f'-{k}', str(v)]
        cmd += [out_path]
        subprocess.run(cmd, check=True, capture_output=True)
        with open(out_path, 'rb') as f:
            return f.read()
    finally:
        os.unlink(out_path)


def make_mp4_video(seed: int) -> bytes:      return _ffmpeg_video(seed, 'mp4', 'libx264')
def make_mov(seed: int) -> bytes:            return _ffmpeg_video(seed, 'mov', 'libx264')
def make_avi(seed: int) -> bytes:            return _ffmpeg_video(seed, 'avi', 'mpeg4')


# ── Audio producers ────────────────────────────────────────────────────

def _sine_1sec(seed: int) -> np.ndarray:
    """1s float32 sine at (400 + seed % 200) Hz, mono, 8kHz."""
    hz = 400 + (seed % 200)
    t = np.arange(DEFAULT_SR) / DEFAULT_SR
    return (0.5 * np.sin(2 * np.pi * hz * t)).astype(np.float32)


def make_wav(seed: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, _sine_1sec(seed), DEFAULT_SR, format='WAV', subtype='PCM_16')
    return buf.getvalue()


def make_flac(seed: int) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, _sine_1sec(seed), DEFAULT_SR, format='FLAC', subtype='PCM_16')
    return buf.getvalue()


def _ffmpeg_audio(seed: int, ext: str, codec: str, bitrate: str = '32k') -> bytes:
    hz = 400 + (seed % 200)
    with tempfile.NamedTemporaryFile(suffix='.' + ext, delete=False) as tf:
        out_path = tf.name
    try:
        subprocess.run([
            'ffmpeg', '-y',
            '-f', 'lavfi',
            '-i', f'sine=frequency={hz}:duration=1',
            '-ar', str(DEFAULT_SR),
            '-c:a', codec, '-b:a', bitrate,
            out_path,
        ], check=True, capture_output=True)
        with open(out_path, 'rb') as f:
            return f.read()
    finally:
        os.unlink(out_path)


def make_mp3(seed: int) -> bytes:
    """audio/mpeg — MP3, libmp3lame."""
    return _ffmpeg_audio(seed, 'mp3', 'libmp3lame')


def make_mp4_audio(seed: int) -> bytes:
    """audio/mp4 — AAC in .m4a container."""
    return _ffmpeg_audio(seed, 'm4a', 'aac')


# ── Document producers ─────────────────────────────────────────────────

def make_pdf(seed: int) -> bytes:
    """Minimal 1-page PDF via reportlab. Seed appears on the page so
    two seeds produce visibly-different documents."""
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import LETTER
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=LETTER)
    c.setFont('Helvetica', 24)
    c.drawString(72, 720, f'Scruple synthetic PDF — seed {seed}')
    c.setFont('Helvetica', 10)
    c.drawString(72, 690, 'Generated for C2PA Conformance evidence bundle.')
    c.showPage()
    c.save()
    return buf.getvalue()


# ── ML model producer ─────────────────────────────────────────────────

def make_pytorch(seed: int) -> bytes:
    """Small PyTorch state_dict — deterministic tensor weights.
    Uses torch.save(); resulting file is what a c2pa mlModel manifest
    binds to."""
    import torch
    torch.manual_seed(seed)
    state = {
        'linear.weight': torch.randn(4, 2),
        'linear.bias': torch.randn(4),
    }
    buf = io.BytesIO()
    torch.save(state, buf)
    return buf.getvalue()


# ── Registry ───────────────────────────────────────────────────────────

PRODUCERS: Dict[str, Callable[[int], bytes]] = {
    # images
    'image/png':          make_png,
    'image/jpeg':         make_jpeg,
    'image/webp':         make_webp,
    'image/svg+xml':      make_svg,
    'image/tiff':         make_tiff,
    'image/x-adobe-dng':  make_dng,
    'image/heic':         make_heic,
    'image/heif':         make_heif,
    'image/avif':         make_avif,
    'image/gif':          make_gif,
    'image/jxl':          make_jxl,
    # video
    'video/mp4':          make_mp4_video,
    'video/quicktime':    make_mov,
    'video/x-msvideo':    make_avi,
    # audio
    'audio/wav':          make_wav,
    'audio/flac':         make_flac,
    'audio/mpeg':         make_mp3,
    'audio/mp4':          make_mp4_audio,
    # documents
    'application/pdf':    make_pdf,
    # ml model
    'application/x-pytorch': make_pytorch,
}


# Extension per MIME — for evidence-bundle filenames + c2pa dispatch when
# the library prefers a hint.
EXTENSIONS: Dict[str, str] = {
    'image/png':             '.png',
    'image/jpeg':            '.jpg',
    'image/webp':            '.webp',
    'image/svg+xml':         '.svg',
    'image/tiff':            '.tiff',
    'image/x-adobe-dng':     '.dng',
    'image/heic':            '.heic',
    'image/heif':            '.heif',
    'image/avif':            '.avif',
    'image/gif':             '.gif',
    'image/jxl':             '.jxl',
    'video/mp4':             '.mp4',
    'video/quicktime':       '.mov',
    'video/x-msvideo':       '.avi',
    'audio/wav':             '.wav',
    'audio/flac':            '.flac',
    'audio/mpeg':            '.mp3',
    'audio/mp4':             '.m4a',
    'application/pdf':       '.pdf',
    'application/x-pytorch': '.pt',
}


if __name__ == '__main__':
    # Smoke — produce one sample of each format, report size + first 8 bytes
    import binascii
    for mime, fn in PRODUCERS.items():
        try:
            data = fn(seed=42)
            head = binascii.hexlify(data[:8]).decode()
            print(f'  ✓ {mime:26s} {len(data):>10} bytes  head={head}')
        except Exception as e:
            print(f'  ✗ {mime:26s} FAIL {e}')
