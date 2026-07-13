# WO-08 — AWS Nitro Enclave verifier + fetcher

**Phase:** 4 (Remaining verifiers, parallelizable)
**Depends on:** WO-07 (or WO-06 if working in parallel with WO-07)
**Blocks:** none
**Owner:** shared library + Python SDK
**Effort:** ~1.5 days

## Purpose

Support AWS Nitro Enclave attestation for customers running Scruple
integrations inside Nitro Enclaves. This is common for finance /
compliance-heavy AWS customers.

## Deliverables

### 1. Verifier plugin

`packages/scruple-attestation-verifiers/src/plugins/aws_nitro.ts`:

- Parse `attestation_report` as a COSE_Sign1-signed attestation document (per AWS Nitro spec).
- Verify COSE signature against the enclave's certificate.
- Verify certificate chains to AWS Nitro root CA (pinned in package).
- Verify CBOR payload:
  - `nonce` (matches expected)
  - `pcrs` (PCR0..PCR8 present; PCR0 is the enclave image measurement)
  - `timestamp` within freshness window
- Return `VerifyResult` with `provider: 'aws-nitro-enclave'`, `pcr_0`, `module_id`.

Reference: AWS Nitro Enclaves Attestation Documentation, `aws-nitro-enclaves-cose` library.

### 2. Register in dispatch

Add plugin registration to `dispatch.ts`.

### 3. Python SDK fetcher

`packages/scruple-sdk-python/scruple/attestation/aws_nitro.py`:

```python
def fetch(nonce_hex: str) -> AttestationEnvelope:
    """Fetch a fresh Nitro Enclave attestation document.

    Requires running inside an AWS Nitro Enclave (uses /dev/nsm).
    """
    # 1. Import aws_nitro_enclaves_nsm (or equivalent)
    # 2. Call nsm_get_attestation_doc(nonce=bytes.fromhex(nonce_hex))
    # 3. Construct envelope
```

Handle: not-in-enclave → `AttestationUnavailable('not running in Nitro Enclave')`.

## Acceptance criteria

- [ ] Verifier plugin unit tests pass with captured real Nitro attestation.
- [ ] Fetcher unit tests pass (mocked NSM).
- [ ] Ingest accepts a valid Nitro-attested leaf; rejects invalid ones.

## Notes

- Nitro root CA is public and downloadable from AWS; pin the PEM.
- COSE parsing library: use `cose-js` or similar; do NOT hand-roll CBOR/COSE.

## Landing

One commit: `feat(baseline): AWS Nitro Enclave verifier + Python SDK fetcher`.
