"""Prove our C2PA signer handles audio files: synthesize a short WAV → sign → verify.

Not "audio generation" in the AI-model sense — this is the Generator Product boundary
test. Per C2PA vocabulary, "Generator" = the thing that creates and signs the
C2PA manifest bound to an audio file. Content synthesis (Suno, Bark, MusicGen)
is outside our boundary; the boundary is where an audio byte stream arrives and
we produce a signed manifest bound to it.
"""
import hashlib, json, wave, struct, math
from pathlib import Path
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
import c2pa

BASE = Path("/tmp/puffjuly12")
KEYS = BASE / "keys"
ADIR = BASE / "audio-iteration"
ADIR.mkdir(parents=True, exist_ok=True)

CERT_CHAIN = (KEYS / "c2pa-cert-chain.pem").read_text()
PRIV = serialization.load_pem_private_key((KEYS / "c2pa-es256.pem").read_bytes(), password=None)
def sign_cb(data): return PRIV.sign(data, ec.ECDSA(hashes.SHA256()))
def sha(b): return hashlib.sha256(b).hexdigest()

# --- Synthesize a 2-second stereo WAV: a 220Hz sine + a 330Hz sine (major fifth chord)
SR = 44100
DURATION_S = 2.0
frames = int(SR * DURATION_S)
raw = bytearray()
for i in range(frames):
    t = i / SR
    envelope = min(1.0, min(t * 8, (DURATION_S - t) * 8))  # 0.125s attack + release
    l = int(0.35 * envelope * 32767 * math.sin(2 * math.pi * 220 * t))
    r = int(0.35 * envelope * 32767 * math.sin(2 * math.pi * 330 * t))
    raw.extend(struct.pack("<hh", l, r))

wav_path = ADIR / "output.wav"
with wave.open(str(wav_path), "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(bytes(raw))

wav_bytes = wav_path.read_bytes()
print(f"synthesized: {wav_path} ({len(wav_bytes)} bytes, sha256={sha(wav_bytes)[:16]}...)")

# --- Sign with the puffjuly12 C2PA cert
manifest = {
    "claim_generator_info": [{"name": "scruple-puffjuly12-audio", "version": "0.1"}],
    "format": "audio/wav",
    "title": "puffjuly12 audio evidence (synthesized 220Hz + 330Hz stereo tone, 2s)",
    "ingredients": [],
    "assertions": [
        {"label": "c2pa.actions", "data": {"actions": [{
            "action": "c2pa.created",
            "digitalSourceType": "http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia",
            "parameters": {
                "com.scruple.iteration": 1,
                "com.scruple.kind": "audio-synthesis-evidence",
                "com.scruple.method": "python wave + sine tones",
                "com.scruple.sample_rate_hz": SR,
                "com.scruple.duration_s": DURATION_S,
                "com.scruple.output_sha256": sha(wav_bytes),
            }
        }]}}
    ]
}

signer = c2pa.Signer.from_callback(sign_cb, c2pa.C2paSigningAlg.ES256, CERT_CHAIN, None)
signed_path = ADIR / "output.c2pa.wav"
if signed_path.exists(): signed_path.unlink()
with c2pa.Builder(json.dumps(manifest)) as builder:
    builder.sign_file(str(wav_path), str(signed_path), signer)

signed_bytes = signed_path.read_bytes()
print(f"SIGNED: {signed_path} ({len(signed_bytes)} bytes, sha256={sha(signed_bytes)[:16]}...)")

# --- Verify with c2pa.Reader
with c2pa.Context() as ctx:
    with open(signed_path, "rb") as f:
        with c2pa.Reader("audio/wav", f, context=ctx) as reader:
            state = reader.get_validation_state()
            js = json.loads(reader.json())
            codes = [v.get("code") for v in js.get("validation_status", [])]
            active = js.get("active_manifest")
            am = js.get("manifests", {}).get(active, {})
print(f"c2pa.Reader validation_state: {state}")
print(f"codes: {codes}")
print(f"signature_alg: {am.get('signature_info',{}).get('alg')}")
print(f"title: {am.get('title')}")

result = {
    "kind": "audio-synth-evidence",
    "wav_sha256": sha(wav_bytes),
    "wav_bytes": len(wav_bytes),
    "signed_wav_sha256": sha(signed_bytes),
    "signed_wav_bytes": len(signed_bytes),
    "sample_rate_hz": SR,
    "duration_s": DURATION_S,
    "c2pa_reader_state": state,
    "c2pa_reader_codes": codes,
    "c2pa_reader_alg": am.get("signature_info", {}).get("alg"),
    "ok": state == "Valid" and all(c == "signingCredential.untrusted" for c in codes),
}
(ADIR / "sign-result.json").write_text(json.dumps(result, indent=2))
print(f"\nsummary: c2pa.Reader on audio/wav → {result['c2pa_reader_state']} (ok={result['ok']})")
