# puffjuly12 — Full-Send Provenance Bundle

**Merkle root:** `29e9a40e1d436ce7c4aae2edd4c28bad73bfcece8e9477b9da9b43375543016c`
**Iterations:** 5 (FLUX Stay Puft cyberpunk, seeds 26071201–26071205)
**C2PA signer pubkey SHA-256:** `879614a0a05df88d6fa0dee07d188e642d33e38c3a72a5ae86cacd509883a9f3`
**Witness signer pubkey SHA-256:** `406afbff4401344692b635aca58bc0430349a07fc33acba00b52c4313064a4bc`
**L2 substrate evidence:** `l2/sev-snp-substrate/` (SEV-SNP CVM run 2026-07-12T17:49Z)

## What this bundle proves

1. **Each of the 5 iteration outputs is a distinct creative work** — the
   `iterations/{1..5}/output.png` files are unique FLUX generations, each with
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
RVN asset data = SHA-256(BUNDLE.merkle-root.txt) = 26f9dfe515d2552cb3e34fb15d9eae436efb37eb246901ca8b7dd529fdaa3685
      │
      ▼
BUNDLE.merkle-root.txt = 29e9a40e1d436ce7c4aae2edd4c28bad73bfcece8e9477b9da9b43375543016c
      │
      ▼
witness/checkpoint.json  (Merkle tree with 5 leaves, Ed25519 signature over root)
      │
      ▼ (verify each leaf preimage)
iterations/N/{output.png, output.c2pa.png, meta.json}
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
cd puffjuly12-29e9a40e1d43
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
