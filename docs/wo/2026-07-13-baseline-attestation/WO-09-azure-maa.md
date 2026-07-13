# WO-09 — Azure Attestation Service (MAA) verifier + fetcher

**Phase:** 4 (Remaining verifiers, parallelizable)
**Depends on:** WO-07
**Blocks:** none
**Owner:** shared library + Python SDK
**Effort:** ~1.5 days

## Purpose

Support Microsoft Azure Attestation Service (MAA) tokens for customers
running Scruple integrations on Azure Confidential Computing.

## Deliverables

### 1. Verifier plugin

`packages/scruple-attestation-verifiers/src/plugins/azure_maa.ts`:

- Parse `attestation_report` as a MAA JWT.
- Fetch MAA's JWKS from the well-known URL specified in the JWT's `iss`
  claim (cached; refresh every 24h).
- Verify JWT signature against the MAA public key.
- Verify claims:
  - `nonce` matches expected
  - `iat` within freshness window
  - `x-ms-attestation-type` (e.g., `sevsnpvm`, `tdxvm`, `sgx`)
  - `x-ms-compliance-status` == `azure-compliant-cvm` (or equivalent for the underlying TEE)
- Return `VerifyResult` with `provider: 'azure-attestation-service'` and the underlying TEE type + measurements.

### 2. Register in dispatch

Add plugin registration.

### 3. Python SDK fetcher

`packages/scruple-sdk-python/scruple/attestation/azure_maa.py`:

```python
def fetch(nonce_hex: str, maa_endpoint: str = None) -> AttestationEnvelope:
    """Fetch an MAA attestation token.

    On Azure Confidential VMs, uses the guest attestation library
    (Microsoft.Azure.Attestation client SDK equivalent).
    """
    # 1. Import azure attestation client (pip install azure-security-attestation)
    # 2. Fetch platform evidence (SEV-SNP/TDX/SGX report from underlying platform)
    # 3. POST to MAA endpoint with the evidence + nonce
    # 4. Get back JWT
    # 5. Construct envelope
```

## Acceptance criteria

- [ ] Verifier plugin unit tests pass with captured real MAA JWT.
- [ ] Fetcher unit tests pass (mocked MAA response).
- [ ] Ingest accepts a valid MAA-attested leaf; rejects invalid.

## Notes

- MAA endpoint is per-region (e.g., `https://sharedeus.eus.attest.azure.net`).
- MAA JWKS is at `<endpoint>/certs`; cache with reasonable TTL.
- The `x-ms-*` claim namespace has evolved; test against current claim shape.

## Landing

One commit: `feat(baseline): Azure Attestation Service (MAA) verifier + Python SDK fetcher`.
