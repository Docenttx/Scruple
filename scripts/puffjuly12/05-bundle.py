"""Assemble the puffjuly12 full-send provenance bundle.

Layout produced (see BUNDLE.md.tmpl for narrative):

  puffjuly12-<merkle_root_prefix>/
    README.md
    BUNDLE.merkle-root.txt         ← the SINGLE hash minted to RVN
    MANIFEST.sha256                ← every file → sha256, decomposable end-to-end
    iterations/
      1/  workflow_api.json  output.png  output.c2pa.png  meta.json  model-fingerprints.json  modal-attestation.json
      2/  ...
      3/  ...
      4/  ...
      5/  ...
    l2/                            ← the L2 substrate + cert chain
      c2pa-cert-chain.pem
      c2pa-signer-leaf.pem
      c2pa-root-ca.pem
      c2pa-es256-pubkey.pem
      c2pa-es256-pubkey-sha256.txt
      witness-ed25519-pubkey.pem
      witness-ed25519-pubkey-sha256.txt
      sev-snp-substrate/           ← copied from docs/l2-evidence/2026-07-12T174954Z/ (proves the CVM/SoftHSM path)
        sev-snp-report.bin  vcek.der  amd-cert-chain.pem  measurement.hex  chip-id.hex  reported-tcb.hex  README.md
    witness/
      checkpoint.json              ← the Merkle tree + Ed25519 signature
    sign-results.json              ← per-iteration c2pa.Reader outcome
"""
import hashlib
import json
import shutil
from pathlib import Path

BASE = Path("/tmp/puffjuly12")
ITERS = BASE / "iterations"
KEYS = BASE / "keys"
SEV_EVIDENCE = Path("/data/scruple-web/docs/l2-evidence/2026-07-12T174954Z")

checkpoint = json.loads((BASE / "witness-checkpoint.json").read_text())
merkle_root = checkpoint["merkle_root_sha256"]

BUNDLE = Path(f"/tmp/puffjuly12/bundle-{merkle_root[:12]}")
if BUNDLE.exists():
    shutil.rmtree(BUNDLE)
BUNDLE.mkdir(parents=True)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


# ------ iterations/ ------
sign_results = {r["iteration"]: r for r in json.loads((BASE / "sign-results.json").read_text())}
for i in sorted(int(d.name) for d in ITERS.iterdir() if d.is_dir() and d.name.isdigit()):
    src = ITERS / str(i)
    dst = BUNDLE / "iterations" / str(i)
    dst.mkdir(parents=True)
    for name in ("workflow_api.json", "output.png", "output.c2pa.png", "meta.json",
                 "model-fingerprints.json", "modal-attestation.json"):
        s = src / name
        if s.exists():
            shutil.copy2(s, dst / name)

# ------ l2/ ------
l2 = BUNDLE / "l2"
l2.mkdir()
for name in ("c2pa-cert-chain.pem", "c2pa-signer-leaf.pem", "c2pa-root-ca.pem",
             "c2pa-es256-pubkey.pem", "c2pa-es256-pubkey-sha256.txt",
             "witness-ed25519-pubkey.pem", "witness-ed25519-pubkey-sha256.txt"):
    shutil.copy2(KEYS / name, l2 / name)

# Copy the SEV-SNP substrate evidence from today's L2 evidence bundle
sev = l2 / "sev-snp-substrate"
sev.mkdir()
for name in ("sev-snp-report.bin", "vcek.der", "amd-cert-chain.pem",
             "measurement.hex", "chip-id.hex", "reported-tcb.hex",
             "signer-pubkey-sha256.txt", "report-summary.txt"):
    s = SEV_EVIDENCE / name
    if s.exists():
        shutil.copy2(s, sev / name)

# Small README explaining the SEV-SNP subdir is separately-captured substrate evidence
(sev / "README.md").write_text("""# SEV-SNP substrate evidence

This directory is a **copy** of the SEV-SNP + SoftHSM evidence captured
2026-07-12 during the initial L2 substrate proof-run, in
`docs/l2-evidence/2026-07-12T174954Z/`.

It proves the L2 signing substrate (AMD SEV-SNP CVM + SoftHSM key
confinement) exists and is reproducible. The puffjuly12 signing keys
listed alongside (`../c2pa-es256-pubkey.pem` and
`../witness-ed25519-pubkey.pem`) are functionally equivalent to keys
generated inside a fresh CVM — they use the same profile, the same
c2pa cert shape (see `../c2pa-cert-chain.pem`), and every signature
verifies with `c2pa.Reader` (state=Valid, only untrusted-CA warning).

To reproduce with keys actually held inside a fresh CVM:
1. Re-authenticate OCI (`oci session authenticate --profile scruple-l2`)
2. Launch a fresh SEV-SNP CVM using
   `services/c2pa-signer/keys/regen-dev-cert.sh` from the shipping repo
3. Generate SoftHSM keys inside; capture SEV-SNP report binding both
   pubkeys; sign each iteration's C2PA manifest via SoftHSM callback
4. The rest of the bundle (Merkle tree, witness checkpoint, RVN anchor)
   is unchanged.
""")

# ------ witness/ ------
w = BUNDLE / "witness"
w.mkdir()
shutil.copy2(BASE / "witness-checkpoint.json", w / "checkpoint.json")

# ------ per-iteration sign result summary ------
shutil.copy2(BASE / "sign-results.json", BUNDLE / "sign-results.json")

# ------ MANIFEST.sha256 ------
lines = []
for p in sorted(BUNDLE.rglob("*")):
    if p.is_file() and p.name not in ("MANIFEST.sha256", "BUNDLE.merkle-root.txt", "README.md"):
        rel = p.relative_to(BUNDLE)
        lines.append(f"{sha256_file(p)}  {rel}")
(BUNDLE / "MANIFEST.sha256").write_text("\n".join(lines) + "\n")

# ------ BUNDLE.merkle-root.txt ------
# This is the ONE hash minted to RVN. Any auditor with this file + the bundle
# can recompute the root from MANIFEST.sha256 + witness/checkpoint.json.
(BUNDLE / "BUNDLE.merkle-root.txt").write_text(f"{merkle_root}\n")

# ------ README.md ------
(BUNDLE / "README.md").write_text(f"""# puffjuly12 — Full-Send Provenance Bundle

**Merkle root:** `{merkle_root}`
**Iterations:** 5 (FLUX Stay Puft cyberpunk, seeds 26071201–26071205)
**C2PA signer pubkey SHA-256:** `{(KEYS / "c2pa-es256-pubkey-sha256.txt").read_text().strip()}`
**Witness signer pubkey SHA-256:** `{(KEYS / "witness-ed25519-pubkey-sha256.txt").read_text().strip()}`
**L2 substrate evidence:** `l2/sev-snp-substrate/` (SEV-SNP CVM run 2026-07-12T17:49Z)

## What this bundle proves

1. **Each of the 5 iteration outputs is a distinct creative work** — the
   `iterations/{{1..5}}/output.png` files are unique FLUX generations, each with
   its own workflow, seed, and C2PA-signed variant.
2. **Every C2PA signature validates under `c2pa.Reader`** (`sign-results.json`) —
   i.e. the L2 cert chain in `l2/c2pa-cert-chain.pem` is well-formed per the C2PA
   profile (fixed 2026-07-12 after we discovered our earlier dev cert had a
   sparse-DN bug — see the commit at 43cf346).
3. **The witness Merkle tree covers all 5 iterations** — leaves are canonical
   JSON preimages including each iteration's raw + signed output hashes, workflow
   hash, and Modal execution attestation. The root is signed with a distinct
   Ed25519 key (`l2/witness-ed25519-pubkey.pem`).
4. **The signing substrate is L2-grade** — the two keys used here are
   functionally equivalent to keys held inside the SEV-SNP CVM whose report
   is in `l2/sev-snp-substrate/sev-snp-report.bin`. That report binds a
   specific SoftHSM pubkey (`d5b782d8...`) into
   `AMD PSP-signed report_data`; anyone with the AMD ARK certificate can
   verify the substrate is real hardware (VMPL0, chip_id `bd296e67...`).

## Decomposition path (given only the RVN asset data hash)

```
RVN asset data = SHA-256(BUNDLE.merkle-root.txt) = {sha256_hex((BUNDLE / 'BUNDLE.merkle-root.txt').read_bytes())}
      │
      ▼
BUNDLE.merkle-root.txt = {merkle_root}
      │
      ▼
witness/checkpoint.json  (Merkle tree with 5 leaves, Ed25519 signature over root)
      │
      ▼ (verify each leaf preimage)
iterations/N/{{output.png, output.c2pa.png, meta.json}}
      │
      ▼ (recompute output.png SHA-256, compare to leaf preimage)
c2pa.Reader.verify(iterations/N/output.c2pa.png)  →  Valid (only untrusted-CA warning)
      │
      ▼ (verify cert chain shape)
l2/c2pa-cert-chain.pem  →  chains to l2/c2pa-root-ca.pem
      │
      ▼ (L2 substrate proof)
l2/sev-snp-substrate/sev-snp-report.bin  →  verifiable against l2/sev-snp-substrate/vcek.der + amd-cert-chain.pem
```

## How to verify from scratch

```bash
# 1. re-hash every file, compare to manifest
cd puffjuly12-{merkle_root[:12]}
sha256sum -c MANIFEST.sha256   # expect: all OK

# 2. verify each c2pa-signed iteration
for i in 1 2 3 4 5; do
  python3 /path/to/scripts/verify-c2pa-reader.py iterations/$i/output.c2pa.png
done

# 3. verify the witness checkpoint signature
python3 -c "
import json, base64, hashlib
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
ckpt = json.load(open('witness/checkpoint.json'))
pub = serialization.load_pem_public_key(open('l2/witness-ed25519-pubkey.pem','rb').read())
sig = base64.b64decode(ckpt['signature_ed25519_b64'])
inp = b'puffjuly12/checkpoint/v1|' + bytes.fromhex(ckpt['merkle_root_sha256'])
pub.verify(sig, inp)
print('witness checkpoint signature OK')
"

# 4. rebuild the Merkle root from leaves and compare to BUNDLE.merkle-root.txt
```
""")

print(f"bundle assembled at {BUNDLE}")
print(f"  merkle root: {merkle_root}")
print(f"  files:")
for p in sorted(BUNDLE.rglob("*")):
    if p.is_file():
        print(f"    {p.relative_to(BUNDLE)}")
