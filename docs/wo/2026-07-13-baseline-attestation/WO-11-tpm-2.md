# WO-11 — TPM 2.0 Quote verifier + fetcher

**Phase:** 4 (Remaining verifiers, parallelizable)
**Depends on:** WO-07
**Blocks:** none
**Owner:** shared library + Python SDK
**Effort:** ~1.5 days

## Purpose

Support TPM 2.0 Quote-based attestation for on-prem customers whose
platforms have TPMs but not CVM/TEE support. This is the "legacy but
still meaningful" attestation path.

## Deliverables

### 1. Verifier plugin

`packages/scruple-attestation-verifiers/src/plugins/tpm_2.ts`:

- Parse `attestation_report` as a TPM 2.0 TPMS_ATTEST structure + signature (per TPM 2.0 Library spec §31.2.5).
- Verify signature over TPMS_ATTEST using the AIK (Attestation Identity Key) public part.
- Verify AIK cert chains to a manufacturer TPM EK CA (pinned per major vendor: Infineon, STMicro, Intel, AMD PSP).
- Verify:
  - `qualifiedSigner` matches expected AIK name
  - `extraData` (nonce field) matches expected nonce_hex
  - `type == TPM_ST_ATTEST_QUOTE`
  - `attested.quote.pcrSelect` and `attested.quote.pcrDigest` present
  - `clockInfo.clock` within freshness window (TPM clock can be trusted per PCR11)
- Return `VerifyResult` with `provider: 'tpm-2.0-quote'`, `pcr_bank`, `pcr_digest`, `aik_name`.

### 2. Register in dispatch

Add plugin registration.

### 3. Python SDK fetcher

`packages/scruple-sdk-python/scruple/attestation/tpm_2.py`:

```python
def fetch(nonce_hex: str, pcrs: list[int] = None) -> AttestationEnvelope:
    """Fetch a TPM 2.0 Quote over the specified PCRs.

    Uses tpm2-pytss library. Requires TPM 2.0 device (/dev/tpmrm0) and
    an available AIK. AIK creation is a one-time setup step outside this
    function; see documentation.
    """
    # 1. Import tpm2_pytss
    # 2. Load AIK by handle
    # 3. Call Tpm2_Quote with extraData = nonce_bytes, pcrs = specified
    # 4. Fetch AIK certificate from local store (or from EK cert if platform-provisioned)
    # 5. Construct envelope
```

## Acceptance criteria

- [ ] Verifier plugin unit tests pass with captured TPM quote fixtures.
- [ ] Fetcher unit tests pass (mocked tpm2-pytss).
- [ ] Ingest accepts a valid TPM-attested leaf; rejects invalid.

## Notes

- Multi-vendor TPM EK CA support: pin CA certs for Infineon, STMicro,
  Nuvoton, Intel, AMD in the package. Document how customers with rare
  TPM vendors add their own CA (config-driven).
- PCR bank selection: SHA-256 by default; document that SHA-1 is
  deprecated and will be rejected.
- Real integration on the AI Council box: probably no TPM, so mock-heavy
  testing for this WO. Actual customer smoke happens when a TPM-carrying
  customer integrates.

## Landing

One commit: `feat(baseline): TPM 2.0 Quote verifier + Python SDK fetcher`.
