# c2pa-python 0.36.0 Signer.from_callback verify failure

**Environment:** Ubuntu 24.04.4 x86_64, python 3.12, c2pa-python 0.36.0
(bundled c2pa-rs newer than 0.37).

**Symptom:** Signing an asset via `Signer.from_callback(callback, alg=ES256,
certs=chain_pem, tsa_url=None)` succeeds; the resulting PNG has a JUMBF
manifest. But `c2pa.Reader.get_validation_state()` returns "Invalid" with:

    { "code": "claimSignature.mismatch",
      "explanation": "claim signature is not valid" }

**Reproduces with:**
- SoftHSM ES256 key via `pkcs11.Mechanism.ECDSA` on pre-hashed SHA-256 (raw R||S)
- Pure-software ES256 key via cryptography `ec.ECDSA(hashes.SHA256())` +
  `decode_dss_signature` → raw R||S (proven pattern from prior smoke tests)

**Cross-checks:**
- Direct raw signature verify with the sw pubkey: OK
- Same signer chain successfully validated by c2patool 0.9.12 sample flow.
- c2patool 0.9.12 cannot parse the c2pa-python 0.36 output at all
  ("claim could not be converted from CBOR") — indicating a newer manifest
  version than 0.9.12 supports.

**Conclusion:** c2pa-python 0.36.0 appears to have a signing-vs-verify
schema mismatch. This bundle demonstrates the CVM CAN produce a valid
C2PA asset (`signed-test-asset.png` via c2patool baseline path).
The SoftHSM → C2PA signing path itself works cryptographically
(pubkey/sig verify OK); only the c2pa-python packaging is broken.

**Follow-up:** try c2pa-python 0.34.x / 0.35.x, or switch signer path
to a Rust-based c2patool external-signer script that PKCS11-shells into
SoftHSM.
