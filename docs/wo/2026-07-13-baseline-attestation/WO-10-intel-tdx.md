# WO-10 — Intel TDX verifier + fetcher

**Phase:** 4 (Remaining verifiers, parallelizable)
**Depends on:** WO-07
**Blocks:** none
**Owner:** shared library + Python SDK
**Effort:** ~2 days

## Purpose

Support Intel TDX attestation for customers on Intel Trust Domain Extensions
platforms (e.g., some Azure / GCP Confidential VM offerings).

## Deliverables

### 1. Verifier plugin

`packages/scruple-attestation-verifiers/src/plugins/intel_tdx.ts`:

- Parse `attestation_report` as a TDX Quote (per Intel TDX Quote v4/v5 spec).
- Verify Quote signature against the TDX Quoting Enclave (QE) attestation key.
- Verify QE attestation key chains to Intel's Provisioning Certification Service (PCS) root.
- Fetch TCB collateral from Intel's PCS (pinned root; cache TCB info).
- Verify:
  - `report_data` (64 bytes; first 32 = expected nonce_hex)
  - `mr_td`, `rt_mr[]` (measurement registers) present
  - `tcb_status == 'UpToDate'` or `'SWHardeningNeeded'` (configurable)
  - `attestation_time` within freshness window
- Return `VerifyResult` with `provider: 'intel-tdx'`, `mr_td`, `tcb_status`.

Reference: Intel TDX DCAP Quote Verification Library, Intel TDX ABI Reference.

### 2. Register in dispatch

Add plugin registration.

### 3. Python SDK fetcher

`packages/scruple-sdk-python/scruple/attestation/intel_tdx.py`:

```python
def fetch(nonce_hex: str) -> AttestationEnvelope:
    """Fetch a fresh TDX Quote.

    On TDX Confidential VMs, uses /dev/tdx_guest (Linux TDX guest driver).
    """
    # 1. Open /dev/tdx_guest or /dev/tdx-attest
    # 2. ioctl(TDX_CMD_GET_QUOTE, report_data=nonce_bytes || zeros[32])
    # 3. Construct envelope with quote + Intel PCK cert chain
```

## Acceptance criteria

- [ ] Verifier plugin unit tests pass with captured real TDX quote.
- [ ] Fetcher unit tests pass (mocked ioctl).
- [ ] Ingest accepts a valid TDX-attested leaf; rejects invalid.

## Notes

- Intel PCS API for TCB collateral: `https://api.trustedservices.intel.com/tdx/certification/v4/tcb`.
- TDX Quote v4 vs v5 format differences — support v5 first (current); v4 as fallback if we see it in the wild.
- DCAP quote verification library exists in C; can shell to it via a small wrapper if TS port is expensive.

## Landing

One commit: `feat(baseline): Intel TDX verifier + Python SDK fetcher`.
