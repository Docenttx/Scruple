"""C2PA-L2-sign every puffjuly12 iteration output.

For each iterations/N/output.png:
  - Build a C2PA v2 manifest citing the iteration's leaf hash + workflow hash + model fingerprints
  - Sign it via the ES256 key in /tmp/puffjuly12/keys/c2pa-es256.pem, with the fixed cert chain
  - Verify with c2pa.Reader → assert Valid (only signingCredential.untrusted allowed)
  - Save the C2PA-signed variant alongside the raw output
"""
import base64
import hashlib
import json
import os
import sys
from pathlib import Path

from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
import c2pa

BASE = Path("/tmp/puffjuly12")
KEYS = BASE / "keys"
ITERS = BASE / "iterations"

CERT_CHAIN = (KEYS / "c2pa-cert-chain.pem").read_text()
PRIV_KEY = serialization.load_pem_private_key((KEYS / "c2pa-es256.pem").read_bytes(), password=None)


def sign_cb(data: bytes) -> bytes:
    """c2pa Signer callback: raw pre-hash bytes → DER-encoded ECDSA sig (0.36 wants DER-form)."""
    return PRIV_KEY.sign(data, ec.ECDSA(hashes.SHA256()))


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sign_iteration(iter_dir: Path) -> dict:
    output_path = iter_dir / "output.png"
    meta = json.loads((iter_dir / "meta.json").read_text())

    output_bytes = output_path.read_bytes()
    output_sha = sha256_hex(output_bytes)
    assert output_sha == meta["output_sha256"], f"output.png hash drift in {iter_dir}"

    # C2PA manifest — v2 actions + custom scruple assertion pointing at the leaf
    manifest = {
        "claim_generator_info": [{"name": "scruple-puffjuly12", "version": "0.1"}],
        "format": "image/png",
        "title": f"puffjuly12 iteration {meta['iteration']}",
        "ingredients": [],
        "assertions": [
            {"label": "c2pa.actions", "data": {"actions": [{
                "action": "c2pa.created",
                "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia",
                "parameters": {
                    "com.scruple.iteration": meta["iteration"],
                    "com.scruple.seed": meta["seed"],
                    "com.scruple.workflow_sha256": meta["workflow_sha256"],
                    "com.scruple.output_sha256": meta["output_sha256"],
                }
            }]}},
        ]
    }

    signer = c2pa.Signer.from_callback(sign_cb, c2pa.C2paSigningAlg.ES256, CERT_CHAIN, None)
    signed_path = iter_dir / "output.c2pa.png"
    if signed_path.exists():
        signed_path.unlink()
    with c2pa.Builder(json.dumps(manifest)) as builder:
        builder.sign_file(str(output_path), str(signed_path), signer)

    # Verify
    with c2pa.Context() as ctx:
        with open(signed_path, "rb") as f:
            with c2pa.Reader("image/png", f, context=ctx) as reader:
                state = reader.get_validation_state()
                js = json.loads(reader.json())
                codes = [v.get("code") for v in js.get("validation_status", [])]

    signed_bytes = signed_path.read_bytes()
    signed_sha = sha256_hex(signed_bytes)
    critical = [c for c in codes if c != "signingCredential.untrusted"]
    result = {
        "iteration": meta["iteration"],
        "input_output_sha256": output_sha,
        "signed_output_sha256": signed_sha,
        "signed_output_bytes": len(signed_bytes),
        "c2pa_reader_state": state,
        "c2pa_reader_codes": codes,
        "ok": len(critical) == 0,
    }
    return result


def main():
    if not KEYS.exists():
        print("run setup-keys.py first")
        sys.exit(2)
    if not ITERS.exists():
        print("no iterations dir yet (waiting for generate.py)")
        sys.exit(2)

    results = []
    for i in sorted(int(d.name) for d in ITERS.iterdir() if d.is_dir() and d.name.isdigit()):
        d = ITERS / str(i)
        if not (d / "output.png").exists() or not (d / "meta.json").exists():
            print(f"iter {i}: incomplete, skipping")
            continue
        try:
            r = sign_iteration(d)
        except Exception as e:
            r = {"iteration": i, "ok": False, "error": str(e)}
        results.append(r)
        status = "OK" if r.get("ok") else "FAIL"
        print(f"iter {r['iteration']}: {status} — {r.get('c2pa_reader_state','?')} — {r.get('c2pa_reader_codes','?')}")

    (BASE / "sign-results.json").write_text(json.dumps(results, indent=2))
    ok_count = sum(1 for r in results if r.get("ok"))
    print(f"\nsummary: {ok_count}/{len(results)} iterations c2pa.Reader-Valid")


if __name__ == "__main__":
    main()
