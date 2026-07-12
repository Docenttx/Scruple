#!/usr/bin/env python3
"""Verify a signed C2PA asset via c2pa.Reader.

The Rust verifier CLI (packages/scruple-verify) only checks our own witness-leaf
chain, not the actual COSE_Sign1 signature bytes embedded in the JUMBF manifest.
Without this script, the shipping E2E test happily passes even when the on-disk
signature is cryptographically invalid — as we discovered on 2026-07-12.

Usage:
    python3 scripts/verify-c2pa-reader.py <signed-asset-path>

Exit codes:
    0  — validation_state == "Valid", or only signingCredential.untrusted (the
         dev cert lives outside c2pa's trust list — expected for local runs)
    1  — any other validation code (real signature/cert/manifest failure)
    2  — file missing / cannot open / c2pa-python not installed

Prints a one-line JSON summary to stdout for machine consumption.
"""
import json
import sys
from pathlib import Path

if len(sys.argv) < 2:
    print(json.dumps({"ok": False, "error": "usage: verify-c2pa-reader.py <asset>"}))
    sys.exit(2)

asset = Path(sys.argv[1])
if not asset.exists():
    print(json.dumps({"ok": False, "error": f"asset not found: {asset}"}))
    sys.exit(2)

try:
    import c2pa
except Exception as e:
    print(json.dumps({"ok": False, "error": f"c2pa import failed: {e}"}))
    sys.exit(2)

# Common image mime types by extension. Extend as needed.
_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
}
mime = _MIME.get(asset.suffix.lower(), "image/png")

# BENIGN_CODES = validation errors we tolerate for dev/CI where the leaf cert
# is not chained to a c2pa-trusted issuer. Any code NOT in this set is fatal.
BENIGN_CODES = {"signingCredential.untrusted"}

with c2pa.Context() as ctx:
    with open(asset, "rb") as f:
        with c2pa.Reader(mime, f, context=ctx) as reader:
            state = reader.get_validation_state()
            payload = json.loads(reader.json())

vs = payload.get("validation_status", [])
codes = [v.get("code") for v in vs]
fatal = [c for c in codes if c not in BENIGN_CODES]

out = {
    "ok": len(fatal) == 0,
    "asset": str(asset),
    "validation_state": state,
    "codes": codes,
    "fatal_codes": fatal,
}
print(json.dumps(out))
sys.exit(0 if out["ok"] else 1)
