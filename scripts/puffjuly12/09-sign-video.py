"""C2PA-sign the puffjuly12 img2vid MP4 output + verify with c2pa.Reader."""
import hashlib, json, os
from pathlib import Path
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
import c2pa

BASE = Path("/tmp/puffjuly12")
KEYS = BASE / "keys"
VDIR = BASE / "video-iteration"

CERT_CHAIN = (KEYS / "c2pa-cert-chain.pem").read_text()
PRIV = serialization.load_pem_private_key((KEYS / "c2pa-es256.pem").read_bytes(), password=None)

def sign_cb(data): return PRIV.sign(data, ec.ECDSA(hashes.SHA256()))
def sha(b): return hashlib.sha256(b).hexdigest()

# Update meta.json with correct MP4 fields
meta = json.loads((VDIR / "meta.json").read_text())
mp4_bytes = (VDIR / "output.mp4").read_bytes()
webp_bytes = (VDIR / "output.webp").read_bytes()
meta.update({
    "output_content_type": "video/mp4",
    "output_container_conversion": "animated webp → h264 mp4 via ffmpeg (24fps, crf 20)",
    "webp_output_sha256": sha(webp_bytes),
    "webp_output_bytes": len(webp_bytes),
    "output_sha256": sha(mp4_bytes),
    "output_bytes": len(mp4_bytes),
})
(VDIR / "meta.json").write_text(json.dumps(meta, indent=2))
print(f"MP4: {len(mp4_bytes)} bytes, sha256={meta['output_sha256'][:16]}...")

# C2PA manifest for video
manifest = {
    "claim_generator_info": [{"name": "scruple-puffjuly12", "version": "0.1"}],
    "format": "video/mp4",
    "title": "puffjuly12 img2vid iteration 1 (Stay Puft cinemapan)",
    "ingredients": [],
    "assertions": [
        {"label": "c2pa.actions", "data": {"actions": [{
            "action": "c2pa.created",
            "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia",
            "parameters": {
                "com.scruple.iteration": 1,
                "com.scruple.kind": "img2vid",
                "com.scruple.model": "ltx-video-2b-v0.9.5",
                "com.scruple.input_image_sha256": meta["input_image_sha256"],
                "com.scruple.workflow_sha256": meta["workflow_sha256"],
                "com.scruple.output_sha256": meta["output_sha256"],
            }
        }]}}
    ]
}

signer = c2pa.Signer.from_callback(sign_cb, c2pa.C2paSigningAlg.ES256, CERT_CHAIN, None)
signed_path = VDIR / "output.c2pa.mp4"
if signed_path.exists(): signed_path.unlink()
with c2pa.Builder(json.dumps(manifest)) as builder:
    builder.sign_file(str(VDIR / "output.mp4"), str(signed_path), signer)

signed_bytes = signed_path.read_bytes()
print(f"SIGNED: {len(signed_bytes)} bytes, sha256={sha(signed_bytes)[:16]}...")

# Verify with c2pa.Reader
with c2pa.Context() as ctx:
    with open(signed_path, "rb") as f:
        with c2pa.Reader("video/mp4", f, context=ctx) as reader:
            state = reader.get_validation_state()
            js = json.loads(reader.json())
            codes = [v.get("code") for v in js.get("validation_status", [])]
            active = js.get("active_manifest")
            am = js.get("manifests", {}).get(active, {})
print(f"c2pa.Reader validation_state: {state}")
print(f"codes: {codes}")
print(f"signature_alg: {am.get('signature_info',{}).get('alg')}")
print(f"title: {am.get('title')}")

# Save the verify result
result = {
    "iteration": 1,
    "kind": "img2vid",
    "input_image_sha256": meta["input_image_sha256"],
    "input_workflow_sha256": meta["workflow_sha256"],
    "video_mp4_sha256": meta["output_sha256"],
    "video_webp_sha256": meta["webp_output_sha256"],
    "signed_video_mp4_sha256": sha(signed_bytes),
    "signed_video_mp4_bytes": len(signed_bytes),
    "c2pa_reader_state": state,
    "c2pa_reader_codes": codes,
    "c2pa_reader_alg": am.get("signature_info", {}).get("alg"),
    "ok": state == "Valid" and all(c == "signingCredential.untrusted" for c in codes),
}
(VDIR / "sign-result.json").write_text(json.dumps(result, indent=2))
print(f"\nsummary: c2pa.Reader on video/mp4 → {result['c2pa_reader_state']} (ok={result['ok']})")
