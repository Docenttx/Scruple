# training-181 — C2PA sidecar for the Stay Puft cyberpunk LoRA

**Scruple project id:** 181
**Scruple ID:** `SCR_DB433994`
**Status:** `persistent_locked` (RVN testnet + IPFS + Arweave, 2026-07-05)
**Trained artifact:** `stay-puft-cyberpunk-lora-r4.safetensors`
**Trained artifact SHA-256:** `31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b`
**RVN txid (raven-testnet):** `32882d63ff67b75c99d4c5fbcc651b5c7d83d862a771f8651b091af22f52b616`
**Merkle root:** `1404513c398fe04b98a88523b3c1dfac82c1c53c3de7e70eb34d56c49ccfbe97`
**IPFS CID:** `bafkreiffhfhdepwvumfje75ojztufagx7qwnq6gcdckkhvylpclhanempa`
**Arweave tx:** `98-2Udb-TMUfCxRI-kYUuatktkHRnAcDB3WduGdmSnI`

## Files

| File | Purpose |
| --- | --- |
| `stay-puft-cyberpunk-lora-r4.safetensors.c2pa` | The signed sidecar (JUMBF-wrapped C2PA manifest store, COSE_Sign1 signature over the claim, x5chain=leaf+root DER). |
| `manifest.json` | The pre-sign C2PA manifest JSON — human-inspectable copy of exactly what got signed (assertions, actions, hash binding, custom Scruple leaf assertion). |
| `verification-report.json` | Independent decomposer output: extracts every assertion from the CBOR-in-JUMBF, verifies the LoRA hash binding, walks leaf → Merkle root → RVN txid, checks the COSE_Sign1 x5chain leaf public key against the puffjuly12 signer, records `c2pa.Reader` diagnostics. |
| `NOTES.md` | Judgment calls made while building this — schema-choice notes, DB anomalies observed, why we ship a sidecar. |

## Why a sidecar and not an embedded manifest

`c2pa-rs` 0.36 has no `.safetensors` handler — it can't parse or rewrite the
container. And modifying the model bytes would break byte-identity for every
downstream loader (`diffusers`, ComfyUI, kohya-ss, HF Hub) that keys caches
by whole-file SHA-256.

So we bind by hash: the sidecar carries the model's SHA-256 in a signed
`c2pa.hash.data` assertion. The verifier hashes the model, matches, and
validates the COSE_Sign1 signature and cert chain independently.

## How a verifier uses this

```bash
MODEL=stay-puft-cyberpunk-lora-r4.safetensors
SIDECAR=stay-puft-cyberpunk-lora-r4.safetensors.c2pa

# 1. Hash the model file, compare against c2pa.hash.data in the sidecar
sha256sum "$MODEL"
# should equal: 31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b

# 2. Extract c2pa.hash.data.hash from the sidecar's CBOR-in-JUMBF and compare
#    (see decompose_sidecar() in scripts/puffjuly12/12-emit-lora-sidecar.py)

# 3. Verify the COSE_Sign1 signature:
#    - alg is -7 (ES256)
#    - x5chain[0] is a valid X.509 cert whose pubkey SHA-256 matches
#      879614a0a05df88d6fa0dee07d188e642d33e38c3a72a5ae86cacd509883a9f3
#    - x5chain[1] is the root CA at /tmp/puffjuly12/keys/c2pa-root-ca.pem

# 4. Verify Merkle-tree inclusion of the leaf:
#    project 181 has iteration_count=1, so leaf_hash == merkle_root:
#    1404513c398fe04b98a88523b3c1dfac82c1c53c3de7e70eb34d56c49ccfbe97

# 5. Verify the anchor on RVN testnet:
#    Look up txid 32882d63ff67b75c99d4c5fbcc651b5c7d83d862a771f8651b091af22f52b616
#    on a raven-testnet explorer. The asset issued at that txid names the SCR ID
#    (SCR_DB433994) and its OP_RETURN carries the package_hash.
```

## Which signing approach worked

**Approach (a)** — `c2pa.Builder.sign(signer, "c2pa", empty_stream, dst_stream)`.
This produces a self-contained JUMBF-wrapped, COSE_Sign1-signed C2PA manifest
store, ~16 KB. `format="c2pa"` tells c2pa-rs to treat the store as its own
container (rather than trying to parse the source stream, which fails for
`.safetensors`).

Approaches (b) `Builder.to_archive` and (c) hand-rolled COSE_Sign1 were not
needed. `to_archive` produces an unsigned pre-sign archive (useful for
staging, but not what we want as the final sidecar). Hand-rolling was
avoided since (a) works and preserves a clean c2pa-rs → c2pa.Reader roundtrip
path.

## Diagnostic: c2pa.Reader without the asset

When you point `c2pa.Reader` at the sidecar without the associated `.safetensors`
bytes, it reports `state=Invalid` with codes
`['signingCredential.untrusted', 'assertion.dataHash.mismatch']`.

- `signingCredential.untrusted` is expected — our puffjuly12 root CA is not
  in c2pa-rs's built-in trust list. (Same behavior as for all puffjuly12
  image/video/audio evidence — see `../sign-results.json`.)
- `assertion.dataHash.mismatch` is expected for a sidecar — the Reader
  hashes the source stream it's given, and we're not giving it the actual
  model bytes. The stored hash is preserved verbatim in the signed CBOR
  and a verifier that has the model file confirms the binding externally.

Both codes are documented in `verification-report.json > diagnostics`.

## Independent verification result

```
$ python3 scripts/puffjuly12/12-emit-lora-sidecar.py
sidecar:  .../training-181/stay-puft-cyberpunk-lora-r4.safetensors.c2pa (16498 bytes)
approach: a: c2pa.Builder.sign(format='c2pa', empty_src)
chain_summary_ok: True
```

`chain_summary_ok: True` means every checkable link held:
- LoRA hash binding stored correctly (32 raw bytes in c2pa.hash.data CBOR)
- Leaf hash → Merkle root (single-leaf tree, project has iteration_count=1)
- Scruple leaf assertion carries the same RVN txid / IPFS CID / Arweave tx as the DB row
- COSE_Sign1 alg is ES256 (COSE header -7), x5chain has 2 certs, leaf pubkey SHA-256 matches the puffjuly12 signer

The `x5chain[1]` DER cert is the puffjuly12 root CA — a decomposer can
compare its SHA-256 fingerprint against `c2pa-root-ca.pem` from the L2
substrate evidence (`../../l2/`).
