#!/usr/bin/env python3
"""Scruple C2PA signer — subprocess entry point.

Reads a JSON job spec from stdin, signs the asset, writes the signed
asset to disk, prints a JSON result to stdout.

Job spec:
    {
        "asset_path": "/tmp/thumb.png",
        "output_path": "/tmp/thumb.c2pa.png",
        "cert_path": ".../keys/signer.pem",
        "key_path":  ".../keys/signer.key",
        "manifest": {
            "claim_generator": "Scruple/0.1 (c2pa-python/0.36)",
            "format": "image/png",
            "title": "MyDesign",
            "assertions": [
                { "label": "ai.scruple.provenance.v1", "data": {...} },
                ...
            ]
        }
    }

Result (success):
    { "ok": true, "output_path": "...", "bytes": 12345 }

Result (failure):
    { "ok": false, "error": "..." }

The manifest is passed straight through — the caller is responsible
for constructing the assertion list.
"""

from __future__ import annotations

import json
import sys
import traceback
from pathlib import Path


def main() -> int:
    try:
        raw = sys.stdin.read()
        job = json.loads(raw)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad job JSON: {e}"}))
        return 1

    try:
        asset_path = Path(job["asset_path"]).resolve()
        output_path = Path(job["output_path"]).resolve()
        cert_path = Path(job["cert_path"]).resolve()
        key_path = Path(job["key_path"]).resolve()
        manifest = job["manifest"]
    except KeyError as e:
        print(json.dumps({"ok": False, "error": f"missing field {e}"}))
        return 1

    if not asset_path.exists():
        print(json.dumps({"ok": False, "error": f"asset not found: {asset_path}"}))
        return 1
    if not cert_path.exists() or not key_path.exists():
        print(json.dumps({"ok": False, "error": "cert or key not found"}))
        return 1

    try:
        import c2pa
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"c2pa import failed: {e}"}))
        return 1

    # Dev-mode trust relaxation — self-signed certs won't validate against
    # the CAI trust list. In prod (SSL.com / DigiCert-issued cert) drop
    # these lines.
    try:
        c2pa.load_settings('{"verify":{"verify_after_sign":false,"verify_trust":false}}', "json")
    except Exception:
        pass  # older SDKs may not need this

    try:
        cert_bytes = cert_path.read_bytes()
        key_bytes = key_path.read_bytes()

        signer = c2pa.Signer.from_info(
            c2pa.C2paSignerInfo(
                alg=c2pa.C2paSigningAlg.ES256,
                sign_cert=cert_bytes,
                private_key=key_bytes,
                ta_url="http://timestamp.digicert.com",
            )
        )

        builder = c2pa.Builder(manifest)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        if output_path.exists():
            output_path.unlink()

        builder.sign_file(str(asset_path), str(output_path), signer)

        bytes_out = output_path.stat().st_size
        print(json.dumps({
            "ok": True,
            "output_path": str(output_path),
            "bytes": bytes_out,
        }))
        return 0
    except Exception as e:
        print(json.dumps({
            "ok": False,
            "error": f"sign failed: {e}",
            "trace": traceback.format_exc().splitlines()[-6:],
        }))
        return 1


if __name__ == "__main__":
    sys.exit(main())
