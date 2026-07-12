# WO-03 — Signer refactor to `Signer.from_callback` via OCI Vault

**Sprint:** 1
**Estimate:** 8 owner-hours
**Blocking:** WO-01 (Vault key OCID + IAM policy in place)
**Blocks:** WO-04 (isolation wraps the refactored daemon), WO-08 (leaf emission
uses the new call path)

## Goal

Replace the current `Signer.from_info(private_key=<file bytes>)` path in
`services/c2pa-signer/sign.py` with `Signer.from_callback(...)` where the
callback delegates the ECDSA-P256 signature to OCI Vault. After this WO, the
raw C2PA signing private key exists in exactly one place — the OCI Vault HSM
— and never appears in any Scruple process's address space.

## What to build

### 1. New module: `services/c2pa-signer/vault_sign.py`

Provides `vault_sign_es256(data: bytes) -> bytes`. Shape:

```python
import base64
import os
import oci
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

_CLIENT = None
_KEY_ID = None

def _init():
    global _CLIENT, _KEY_ID
    if _CLIENT is not None:
        return
    _KEY_ID = os.environ["SCRUPLE_C2PA_VAULT_KEY_OCID"]
    endpoint = os.environ["SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT"]  # e.g. https://<vault-id>-crypto.kms.us-ashburn-1.oraclecloud.com
    # Instance-principal auth — ambient identity from OCI Dynamic Group.
    # No config file, no API keys on disk.
    signer_auth = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
    _CLIENT = oci.key_management.KmsCryptoClient(
        config={}, signer=signer_auth, service_endpoint=endpoint,
    )

def vault_sign_es256(data: bytes) -> bytes:
    """Sign `data` via OCI Vault ES256, return raw R||S per RFC 8152."""
    _init()
    resp = _CLIENT.sign(
        sign_data_details=oci.key_management.models.SignDataDetails(
            key_id=_KEY_ID,
            message=base64.b64encode(data).decode("ascii"),
            message_type="RAW",
            signing_algorithm="ECDSA_SHA_256",
        )
    )
    # OCI returns base64-encoded DER-encoded ECDSA signature.
    der = base64.b64decode(resp.data.signature)
    r, s = decode_dss_signature(der)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")
```

Add a module-level unit test that mocks the OCI client and asserts the
DER-to-R||S conversion produces exactly 64 bytes for a canonical fixture.

### 2. Refactor `services/c2pa-signer/sign.py`

Replace the `Signer.from_info(...)` block with:

```python
from vault_sign import vault_sign_es256

cert_chain_pem = Path(os.environ["SCRUPLE_C2PA_CERT_CHAIN"]).read_bytes()
ta_url = os.environ.get("SCRUPLE_C2PA_TA_URL", "")  # empty = no timestamp

signer = c2pa.Signer.from_callback(
    callback=vault_sign_es256,
    alg=c2pa.C2paSigningAlg.ES256,
    certs=cert_chain_pem.decode("utf-8"),
    ta_url=ta_url.encode() if ta_url else b"",
)
```

Delete the code paths that read `job["cert_path"]` and `job["key_path"]`
into raw bytes. The job spec still carries `cert_path` (for tests /
overrides) but the daemon MUST refuse to use it in production mode
(see §3).

### 3. Dev-mode gating

The current `c2pa.load_settings('{"verify":{"verify_after_sign":false,
"verify_trust":false}}')` call is retained ONLY when
`os.environ.get("SCRUPLE_C2PA_DEV") == "1"`. Any other value or unset →
no trust relaxation applied.

The prod systemd unit (WO-04) will set `Environment=SCRUPLE_C2PA_DEV=` (empty
string), which fails the equality check. Dev-mode gets `=1`. Never accept any
other truthy value.

### 4. Delete the committed sample key

- Remove `services/c2pa-signer/keys/es256.pem` from the working tree.
- Update `services/c2pa-signer/keys/.gitignore` to `*.pem\n*.key\n*.pk8\n*.p12`
  so no PEM blob under keys/ is ever tracked again.
- Add pre-commit hook in `.githooks/pre-commit-c2pa-key-check` that greps
  staged files for `-----BEGIN.*PRIVATE KEY-----` patterns and rejects the
  commit. Add setup instruction to `README.md` under "Repo setup."
- Note in commit message: sample key is public (from the c2pa-org sample
  directory) so no history scrubbing is needed for confidentiality, but
  the practice of committing PEMs stops here.

### 5. Environment variables (documented in `.env.example`)

```
# OCI Vault C2PA signing key
SCRUPLE_C2PA_VAULT_KEY_OCID=ocid1.key.oc1.us-ashburn-1.xxx
SCRUPLE_C2PA_VAULT_CRYPTO_ENDPOINT=https://xxx-crypto.kms.us-ashburn-1.oraclecloud.com

# Cert chain (file path, NOT the key — the key lives in Vault only)
SCRUPLE_C2PA_CERT_CHAIN=/etc/scruple/c2pa-cert-chain.pem

# Timestamp Authority (optional; blank = no TSA)
SCRUPLE_C2PA_TA_URL=http://timestamp.digicert.com

# Dev mode (NEVER set in prod)
# SCRUPLE_C2PA_DEV=1
```

## What NOT to build

- Do not fall back to file-based private-key loading if the Vault call fails.
  Vault errors surface as sign failures, retried by the caller if appropriate.
- Do not cache signatures. Every sign is a Vault round-trip.
- Do not initialize the OCI client at module import time. Lazy init on first
  call so tests can mock it cleanly.
- Do not log the Vault response body or the derived signature bytes.
- Do not implement key rotation logic in this WO — rotation is manual per
  the runbook (WO-17), and the signer picks up a new OCID on daemon restart.

## Testing

- Unit test for `vault_sign_es256`: mock the OCI client, feed a known DER
  fixture, assert the R||S output is 64 bytes and matches expected.
- Integration test (runs against real Vault, gated by env flag): sign a
  fixed test message, verify the returned signature against the Vault
  public key using `cryptography` library `verify()` locally.
- E2E test: sign the interop test asset `docs/c2pa-interop/scruple-test-signed.png`
  source via the new path, verify with `c2pa-python` reader — should return
  `validation_state: Valid`.

## Acceptance criteria

- [ ] `services/c2pa-signer/sign.py` contains no `from_info(private_key=...)`
      call and no `Path(key_path).read_bytes()` on a private key.
- [ ] `services/c2pa-signer/vault_sign.py` exists with the shape above and
      passes its unit test.
- [ ] `services/c2pa-signer/keys/es256.pem` no longer exists in the working
      tree; `git ls-files services/c2pa-signer/keys/` returns only
      `.gitignore` (and the CI-generated cert chain, when checked in).
- [ ] Pre-commit hook rejects a commit that attempts to add a file
      containing `-----BEGIN PRIVATE KEY-----`.
- [ ] Signing a test PNG through the refactored daemon produces a
      spec-conformant C2PA manifest that verifies clean in c2pa-python.
- [ ] With `SCRUPLE_C2PA_DEV` unset AND the dev sample cert loaded, the
      signer refuses to relax trust (attempted `verify_trust:false`
      settings call is NOT executed).
- [ ] Integration test against real Vault passes (`Sign` + local verify
      of the returned signature against `GetPublicKey`).

## Related

- Canonical design §5 (C2PA Signing Path)
- Canonical design §11 checklist items #1, #3
- WO-01 — provides Vault OCID + IAM
- WO-04 — wraps this daemon in systemd + Unix socket
- WO-08 — after this WO, sign path can emit sign leaves to the audit stream
