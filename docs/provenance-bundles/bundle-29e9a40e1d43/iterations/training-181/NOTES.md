# NOTES — training-181 sidecar retrofit

Judgment calls made while building `12-emit-lora-sidecar.py`.

## 1. `c2pa.hash.data.hash` must be a JSON array-of-ints, not a base64 string

In c2pa-python 0.36, when we pass `c2pa.hash.data` as a JSON assertion, the
JSON→CBOR serializer packs the `hash` field as:

- if given a **string**: text-as-bytes (e.g. base64 string becomes the raw
  ASCII bytes of the string, not the decoded hash). CBOR shows a 44-byte
  bstr containing `M`, `e`, `N`, ..., which is wrong.
- if given a **list of ints (0..255)**: a bstr containing those raw bytes.
  CBOR shows a 32-byte bstr matching the sha256 exactly.
- if given a **hex string**: text-as-bytes (64-byte bstr with hex chars).

We use the list-of-ints form. This lands the raw 32-byte hash in
`c2pa.hash.data.hash` as CBOR bstr, which is the format the C2PA spec calls
for. Verified round-trip in `verification-report.json > model_binding`:
`sidecar_stored_hash_hex == expected_lora_content_hash_sha256_hex`.

## 2. `c2pa.assertion.training-mining` is a semi-standard label

C2PA 2.x defines a `c2pa.training-mining` assertion for declaring
training/mining permissions on the asset. There is no fully-standardized
schema for "this asset IS the trained weights and here is what it was
trained on." The task brief specifies label `c2pa.assertion.training-mining`
and lists the required fields. We use that label and populate it with a
scruple-namespaced sub-schema (`training_run.{trainer, base_model, dataset,
lora, session_hash_sha256_hex, structural_layer_count}`). A future c2pa spec
revision that formalizes a training-provenance assertion would let us drop
the custom sub-schema and align field names.

## 3. `training_runs.base_model_hash` == `iterations.model_fingerprints_hash`

Both DB rows carry the same SHA-256 for project 181:
`31e35c80fc4829d14f90153f4c74cd59c90b779f6afe05a74cd6120b893f7e5b`.

The task brief says this value is the **LoRA output** content hash — which
is what we bind in `c2pa.hash.data`. We treat `iterations.model_fingerprints_hash`
as authoritative for that role. The training-mining assertion faithfully
records `base_model_hash` from the DB anyway (so the anomaly is
reconstructable), but a downstream reader should not treat the DB's
`base_model_hash` for row 2 as "the true SDXL 1.0 checkpoint SHA-256" — the
canonical SDXL 1.0 hash is different. Likely explanation: at ingest time the
trainer wrote the output hash into both columns and no downstream code
distinguished them. Not fixed here — this script is retrofit-only and does
not touch the DB.

## 4. Sidecar format: `format="c2pa"` at sign, empty source stream

`c2pa-rs` accepts `format="c2pa"` to mean "the store is its own asset."
Passing an empty `io.BytesIO(b"")` as the source lets the sign call succeed
without needing to parse a `.safetensors` header (unsupported by c2pa-rs 0.36).
The resulting bytes are a JUMBF superbox containing the assertions box,
claim box, and signature box (COSE_Sign1). This IS the "external manifest"
sidecar format the C2PA spec calls for. Confirmed by parsing the JUMBF and
verifying the alg (-7), x5chain (2 certs), and leaf-pubkey fingerprint.

## 5. `c2pa.Reader` on the sidecar without the asset reports `Invalid`

This is expected diagnostic, not failure:

- `signingCredential.untrusted` — puffjuly12 root CA isn't in c2pa-rs's
  built-in trust list. Same behavior as for every image/video/audio
  iteration in this bundle.
- `assertion.dataHash.mismatch` — the Reader hashes whatever source stream
  we give it. Since we don't have the `.safetensors` bytes locally, we
  can't hand them to the Reader. The stored hash in the CBOR is what a
  verifier compares against when they have the model file. See README.md
  §"How a verifier uses this."

## 6. Signature verification stops at the leaf-pubkey fingerprint

Fully re-computing the COSE_Sign1 ECDSA verify would require reconstructing
the C2PA claim payload that c2pa-rs signed over (Sig_structure1 with the
c2pa.claim.v2 CBOR as external payload). That's plumbing c2pa-rs handles
internally; the round-trip we care about is:

1. x5chain[0] parses as a valid X.509 cert
2. Its public-key SHA-256 (SPKI DER) matches the puffjuly12 signer's
   `c2pa-es256-pubkey-sha256.txt`
3. x5chain[1] is the root CA (2-cert chain, as the puffjuly12 signer emits)
4. COSE header alg is -7 (ES256, per RFC 8152 §8.1)
5. Signature is 64 bytes (ES256 raw ECDSA, per RFC 8152 §8.1)

Anyone who wants to run a full crypto verify can hand the sidecar to a
c2pa.Reader with the correct trust anchor and the actual `.safetensors`
bytes — the Reader does the full COSE + hash + chain verification.

## 7. Idempotency caveat

The pre-sign manifest.json is fully deterministic — re-running the emitter
produces identical `manifest.json` bytes. The sidecar bytes differ each run
because:

1. ECDSA-P256 uses a random nonce (RFC 6979 deterministic ECDSA would fix
   this, but the puffjuly12 signer callback uses `cryptography`'s default
   random-k).
2. c2pa-rs allocates a random instanceID (`xmp:iid:...`) each sign call.

The `chain_summary_ok` field in verification-report.json is invariant across
runs — that's the deterministic assertion the bundle relies on.
