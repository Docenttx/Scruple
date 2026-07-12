"""Test C2PA sign+verify for each candidate audio format."""
import hashlib, json
from pathlib import Path
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
import c2pa

BASE = Path("/tmp/puffjuly12")
KEYS = BASE / "keys"
ADIR = BASE / "audio-iteration"

CERT_CHAIN = (KEYS / "c2pa-cert-chain.pem").read_text()
PRIV = serialization.load_pem_private_key((KEYS / "c2pa-es256.pem").read_bytes(), password=None)
def sign_cb(data): return PRIV.sign(data, ec.ECDSA(hashes.SHA256()))
def sha(b): return hashlib.sha256(b).hexdigest()

# (mime, source_file, output_suffix)
FORMATS = [
    ("audio/flac",  "output.flac", ".c2pa.flac"),
    ("audio/aac",   "output.aac",  ".c2pa.aac"),
    ("audio/mpeg",  "output.mp3",  ".c2pa.mp3"),
    ("audio/mp4",   "output.m4a",  ".c2pa.m4a"),
]

results = {}
for mime, src, dst_ext in FORMATS:
    src_path = ADIR / src
    dst_path = ADIR / (src.rsplit(".",1)[0] + dst_ext)
    print(f"\n=== {mime} ({src}) ===")
    manifest = {
        "claim_generator_info": [{"name": "scruple-puffjuly12-audio-fmt-test", "version": "0.1"}],
        "format": mime,
        "title": f"puffjuly12 audio format test — {mime}",
        "ingredients": [],
        "assertions": [
            {"label": "c2pa.actions", "data": {"actions": [{"action": "c2pa.created", "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia"}]}}
        ]
    }
    if dst_path.exists(): dst_path.unlink()
    try:
        signer = c2pa.Signer.from_callback(sign_cb, c2pa.C2paSigningAlg.ES256, CERT_CHAIN, None)
        with c2pa.Builder(json.dumps(manifest)) as builder:
            builder.sign_file(str(src_path), str(dst_path), signer)
        print(f"  signed: {dst_path.stat().st_size} bytes")
    except Exception as e:
        print(f"  SIGN FAILED: {type(e).__name__}: {str(e)[:200]}")
        results[mime] = {"ok": False, "error_at": "sign", "error": str(e)[:400]}
        continue
    try:
        with c2pa.Context() as ctx:
            with open(dst_path, "rb") as f:
                with c2pa.Reader(mime, f, context=ctx) as reader:
                    state = reader.get_validation_state()
                    js = json.loads(reader.json())
                    codes = [v.get("code") for v in js.get("validation_status", [])]
        print(f"  state: {state}, codes: {codes}")
        results[mime] = {"ok": state == "Valid" and all(c == "signingCredential.untrusted" for c in codes), "state": state, "codes": codes}
    except Exception as e:
        print(f"  VERIFY FAILED: {type(e).__name__}: {str(e)[:200]}")
        results[mime] = {"ok": False, "error_at": "verify", "error": str(e)[:400]}

(ADIR / "format-test-results.json").write_text(json.dumps(results, indent=2))
print("\n=== summary ===")
for mime, r in results.items():
    mark = "✓" if r.get("ok") else "✗"
    print(f"  {mark} {mime}: {r}")
