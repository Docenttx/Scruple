# WO-CVM-01 — L2 Evidence Path: SoftHSM in SEV-SNP CVM

**Sprint:** L2 evidence prerequisite (pre-Sprint-2, on-demand)
**Estimate:** ~8 owner-hours of code + ~2 hours of live CVM evidence run
**Blocking:** none for the code portion. Live evidence run needs the OCI
CVM provisioned (`oci compute instance launch` — user does this on demand).
**Blocks:** the actual L2 Conformance filing to C2PA

## Goal

Wire the code paths that let the Scruple signer run inside an OCI
Confidential Compute VM against a SoftHSM instance, capture the SEV-SNP
attestation report as C2PA L2 evidence, and produce the artifact bundle
that populates `docs/architecture/L2_EVIDENCE_TEMPLATE.md`.

After this WO, the L2 evidence run becomes a ~2-hour, ~$1 exercise:

1. User provisions the CVM (dashboard or `oci compute instance launch`).
2. Runs `deploy/l2-evidence-run/run.sh` on the CVM.
3. Copies the artifact bundle back to `docs/l2-evidence/YYYY-MM-DD/`.
4. Populates `L2_EVIDENCE_TEMPLATE.md` with the artifact paths.
5. Files the C2PA L2 submission with the populated template.
6. Tears down the CVM.

## Architecture recap (see canonical §18)

The SignAsset callback layer already exists (WO-03, commit 0d45097).
`services/c2pa-signer/vault_sign.py` dispatches on
`SCRUPLE_C2PA_VAULT_KEY_OCID`; if unset, falls back to local file. This
WO adds a THIRD dispatch mode: SoftHSM via PKCS#11.

```
SCRUPLE_C2PA_SIGNER_MODE=softhsm        # new: PKCS#11 to SoftHSM
SCRUPLE_C2PA_SOFTHSM_LIBRARY=/usr/lib/softhsm/libsofthsm2.so
SCRUPLE_C2PA_SOFTHSM_SLOT=0
SCRUPLE_C2PA_SOFTHSM_KEY_LABEL=scruple-c2pa-l2
SCRUPLE_C2PA_SOFTHSM_PIN=<env-injected>
```

Same 64-byte raw R||S output; same Node callers; same E2E tests.

## What to build

### 1. `services/c2pa-signer/softhsm_sign.py` (new)

PKCS#11 client that produces ES256 R||S signatures via SoftHSM. Uses
`python-pkcs11` package (installed via `pip install python-pkcs11`)
which speaks the SoftHSM shared library.

```python
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature
import pkcs11

_cached_session = None
_cached_key = None

def _init():
    global _cached_session, _cached_key
    if _cached_session is not None:
        return
    lib = pkcs11.lib(os.environ["SCRUPLE_C2PA_SOFTHSM_LIBRARY"])
    slot = int(os.environ.get("SCRUPLE_C2PA_SOFTHSM_SLOT", "0"))
    token = lib.get_slots(token_present=True)[slot].get_token()
    session = token.open(user_pin=os.environ["SCRUPLE_C2PA_SOFTHSM_PIN"])
    key = session.get_key(
        label=os.environ["SCRUPLE_C2PA_SOFTHSM_KEY_LABEL"],
        object_class=pkcs11.ObjectClass.PRIVATE_KEY,
        key_type=pkcs11.KeyType.EC,
    )
    _cached_session = session
    _cached_key = key

def softhsm_sign_es256(data: bytes) -> bytes:
    """Sign via SoftHSM (PKCS#11). Return raw R||S per RFC 8152."""
    _init()
    # SHA-256 digest first, then EC sign (SoftHSM's SHA256-then-sign
    # varies; explicit digest ensures determinism).
    digest = hashes.Hash(hashes.SHA256())
    digest.update(data)
    hashed = digest.finalize()
    sig_der = _cached_key.sign(hashed, mechanism=pkcs11.Mechanism.ECDSA)
    # SoftHSM returns concatenated R||S (64 bytes) OR DER, depending on
    # mechanism. Verify format at runtime; convert if needed.
    if len(sig_der) == 64:
        return sig_der
    r, s = decode_dss_signature(sig_der)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")

def softhsm_key_identity() -> str:
    _init()
    label = os.environ["SCRUPLE_C2PA_SOFTHSM_KEY_LABEL"]
    slot = os.environ.get("SCRUPLE_C2PA_SOFTHSM_SLOT", "0")
    return f"softhsm:slot{slot}/{label}"
```

Add lazy-import guard so the softhsm mode never triggers on non-CVM
hosts unless the env var is explicitly set.

### 2. Extend `services/c2pa-signer/vault_sign.py`

Add third dispatch branch. Priority: mode env var > vault OCID > local
file.

```python
def _get_signer():
    mode = os.environ.get("SCRUPLE_C2PA_SIGNER_MODE", "").lower()
    if mode == "softhsm":
        from softhsm_sign import softhsm_sign_es256, softhsm_key_identity
        return softhsm_sign_es256, softhsm_key_identity()
    if os.environ.get("SCRUPLE_C2PA_VAULT_KEY_OCID"):
        return _vault_signer_from_env(), _vault_identity()
    return _local_signer_from_env_or_default(), _local_identity()
```

Update `vault_sign_es256` and `signer_identity` to route through
`_get_signer()`.

### 3. `deploy/l2-evidence-run/` (new directory)

Playbook + scripts for the CVM-side portion of the evidence run.

**`deploy/l2-evidence-run/install.sh`** — one-shot install:
- `apt update && apt install -y softhsm2 opensc pkcs11-tools python3-pip`
- `pip install python-pkcs11 cryptography c2pa oci`
- Configure SoftHSM: `softhsm2-util --init-token --free --label scruple-l2-token
  --so-pin 0000 --pin <SCRUPLE_C2PA_SOFTHSM_PIN>`
- Generate the C2PA signing key inside SoftHSM: `pkcs11-tool --module
  /usr/lib/softhsm/libsofthsm2.so --token-label scruple-l2-token
  --keypairgen --key-type EC:prime256v1 --label scruple-c2pa-l2 --login
  --pin <PIN>`

**`deploy/l2-evidence-run/fetch-attestation.py`** — pulls the SEV-SNP
attestation report:
```python
# Uses /dev/sev-guest ioctl. Includes REPORT_DATA = sha256(pubkey) so
# the report binds to the specific SoftHSM key.
import ctypes, fcntl, hashlib, os
# ... ioctl 0xC0405300 (SEV_GUEST_GET_REPORT) ...
```
Alternative: use `snpguest` binary (`https://github.com/virtee/snpguest`)
if available in the CVM's package repo — simpler than direct ioctl.

**`deploy/l2-evidence-run/generate-csr.py`** — creates a CSR from the
SoftHSM-held public key so the L2 signing key can eventually be
certified by the C2PA production issuer (WO-02) without ever exporting
the private key.

**`deploy/l2-evidence-run/run.sh`** — orchestrator:
1. Sanity-check SEV-SNP is enabled: `dmesg | grep "SEV-SNP: SEV-SNP
   supported"` and `cat /sys/module/kvm_amd/parameters/sev_snp`.
2. Compute reproducible-build hash of the signer binary + Python code.
3. Fetch the SEV-SNP attestation report with `REPORT_DATA =
   sha256(signer_pubkey || build_hash)`.
4. Fetch AMD VCEK cert chain for report verification.
5. Sign a test asset (uses the existing
   `scripts/test-c2pa-sign-witness-e2e.ts`, points to the CVM's signer).
6. Run interop verification: c2pa-python, c2pa-node, `scruple-verify c2pa`.
7. Capture OCI Audit events for the CVM lifecycle.
8. Bundle all artifacts into `l2-evidence-YYYY-MM-DD.tar.gz`.
9. Copy the bundle to a specified OCI Object Storage bucket for the user
   to download.

**`deploy/l2-evidence-run/verify-attestation.mjs`** — standalone
verifier that takes an attestation report + AMD VCEK chain and confirms
the signature + measurement. Extends `packages/scruple-verify/` with a
new subcommand `scruple-verify sev-snp-report <report.bin>
<amd-vcek.pem>`.

### 4. Trust manifest enrichment

Extend `app/.well-known/witness-trust.json/route.ts` to advertise the
CVM signing environment when active. Structure per canonical §18.9.
Reads from a new env var:
```
SCRUPLE_C2PA_L2_TOPOLOGY_ATTESTATION_URL=https://scruple.stooges.ai/attest/reports/2026-XX-XX
SCRUPLE_C2PA_L2_TOPOLOGY_MEASUREMENT=<hex>
```

For the ephemeral evidence run, the attestation report is uploaded to
the Scruple site as a static file so verifiers can pull it after the
CVM has been torn down.

### 5. Reference verifier CLI extension

`packages/scruple-verify/src/cli.mjs` gains a subcommand:

```
scruple-verify sev-snp-report <report.bin> [--amd-vcek <path>]
    # Validate a SEV-SNP attestation report:
    # 1. Parse the report structure.
    # 2. Verify the report signature against AMD VCEK.
    # 3. Verify VCEK cert chain to AMD Root CA (published).
    # 4. Extract measurement + report_data.
    # 5. If --expected-measurement provided, assert equality.
    # Exit 0 on VALID; nonzero on FAIL.
```

This is what makes the L2 evidence VERIFIABLE by third parties — anyone
can run this against the attestation report we publish and confirm the
key was generated inside an attested CVM.

Recommended dep: `@virtee/sev-snp` or a raw parser we ship — the report
is a fixed-format 1184-byte binary, not complex.

### 6. Documentation captures

- Update `docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md` §11
  (already done in this session) to reference this WO.
- `docs/architecture/L2_EVIDENCE_TEMPLATE.md` (already exists) —
  populated version will live in `docs/l2-evidence/YYYY-MM-DD/` after
  the run; that folder is `.gitignore`d for production evidence
  packs but this WO adds an `EXAMPLE-populated.md` showing the shape.
- New `deploy/l2-evidence-run/README.md` — operator playbook for the
  live run (see §"Evidence run playbook" below).

## Evidence run playbook (user-facing)

When you're ready to file L2, follow this sequence. Should take under
2 hours total, cost under $2 in OCI billing.

**Prep (~5 min):**
- Confirm your OCI CLI is authenticated (`oci session validate`).
- Confirm your OCI compartment has quota for `VM.Standard.E5.Flex` with
  Confidential Computing (check `oci limits value list --compartment-id
  $C --service-name compute --scope AD`).

**Provision the CVM (~2 min):**
```bash
oci compute instance launch \
  --availability-domain <AD> \
  --compartment-id <SCRUPLE_CRYPTO_COMPARTMENT> \
  --shape VM.Standard.E5.Flex \
  --shape-config '{"ocpus":2,"memoryInGBs":16}' \
  --image-id <ubuntu-22.04-image-ocid> \
  --subnet-id <SUBNET> \
  --platform-config '{
     "type":"AMD_VM",
     "isSecureBootEnabled":true,
     "isMeasuredBootEnabled":true,
     "isMemoryEncryptionEnabled":true
   }' \
  --display-name scruple-l2-evidence-run \
  --metadata '{"ssh_authorized_keys":"<your key>"}' \
  --wait-for-state RUNNING
```

**Run the evidence script (~60-90 min):**
```bash
ssh ubuntu@<cvm-ip>
git clone https://<mirror-of-scruple-web>.git
cd scruple-web
sudo bash deploy/l2-evidence-run/install.sh
bash deploy/l2-evidence-run/run.sh
# artifacts land in ~/l2-evidence-YYYY-MM-DD.tar.gz
```

**Copy artifacts + tear down (~2 min):**
```bash
scp ubuntu@<cvm-ip>:~/l2-evidence-*.tar.gz .
oci compute instance terminate --instance-id <CVM_OCID> --wait-for-state TERMINATED
```

**Populate + file (~30-60 min at your desk):**
- Extract the tarball into `docs/l2-evidence/YYYY-MM-DD/`.
- Populate `L2_EVIDENCE_TEMPLATE.md` bracketed placeholders with the
  actual artifact paths.
- Sign the document.
- Submit via the C2PA Conformance Program portal.
- Select "None of the above" on the attestation question.
- Upload the populated Security Architecture Document.

## What NOT to build

- Do not build the tier-gate runtime routing in this WO — that's a
  separate Sprint 2 WO. This WO is only the code path + evidence run
  to enable the L2 filing.
- Do not connect the CVM to the audit-API / witness backend. The
  evidence run signs a standalone test asset; the audit trail for
  operational customer signs is a separate concern that comes online
  when the CVM is stood up for continuous use.
- Do not commit populated evidence artifacts (measurements are
  sensitive to the specific build). `.gitignore`
  `docs/l2-evidence/*/` — only the empty template is tracked.
- Do not build the trust-manifest attestation publisher until we have
  a real report to publish (comes out of the evidence run).

## Deliverables

- `services/c2pa-signer/softhsm_sign.py`
- Updated `services/c2pa-signer/vault_sign.py` with 3-way dispatch
- `deploy/l2-evidence-run/` directory with install.sh, run.sh,
  fetch-attestation.py, generate-csr.py, verify-attestation.mjs,
  README.md
- Extended `packages/scruple-verify/src/cli.mjs` with `sev-snp-report`
  subcommand + core helpers
- Trust-manifest route enrichment (schema for the topology entry;
  populated after the live run)
- `.gitignore` entry for `docs/l2-evidence/*/`
- Test: extend `scripts/test-c2pa-sign-witness-e2e.ts` to accept
  `SCRUPLE_C2PA_SIGNER_MODE=softhsm` and route through the SoftHSM path
  when set — this is what the evidence-run script triggers.

## Acceptance criteria

- [ ] `SCRUPLE_C2PA_SIGNER_MODE=softhsm` env var routes signing through
      SoftHSM instead of local file; typecheck + parity tests remain
      green.
- [ ] On a CVM with SoftHSM installed, `scripts/test-c2pa-sign-witness-e2e.ts`
      runs green with 24/24 assertions, plus reports
      `signing_mode: 'softhsm'` and `signer_identity: 'softhsm:...'`.
- [ ] `deploy/l2-evidence-run/run.sh` produces a tarball containing
      all 11 artifact types listed in `L2_EVIDENCE_TEMPLATE.md` §12.
- [ ] `scruple-verify sev-snp-report <report.bin>` validates a real
      SEV-SNP report against AMD's public VCEK chain.
- [ ] The attestation report's REPORT_DATA field contains
      `sha256(signer_pubkey || build_hash)` — binds the report to the
      specific key + code.
- [ ] Cost of a single evidence run is under $2 in OCI billing.
- [ ] Rollback plan documented: if L2 filing is rejected, same signer
      code stack works with the local-file backend for L1 signing;
      no re-architecture needed.

## Time estimate

- **Code portion (~8 hours):** softhsm_sign.py + vault_sign.py
  dispatch + evidence-run scripts + verifier extension. Straight code
  work, testable locally with SoftHSM installed on the dev box (no
  CVM required for the code portion).
- **Live evidence run (~2 hours + $2):** when you're ready. First
  time might be closer to 3 hours as you learn the OCI CLI + iron
  out any AMD firmware quirks.

## Related

- Canonical design §18 (this WO's architectural context)
- `docs/architecture/L2_EVIDENCE_TEMPLATE.md` (the doc this WO enables
  populating)
- WO-03 (0d45097) — the callback abstraction this extends
- WO-08 (0d45097) — the witness emit that runs alongside signs
- WO-09 (8a270fd) — the verifier CLI this extends
