# WO-07 — NVIDIA H100 confidential mode: verifier + fetcher + smoke

**Phase:** 3 (NVIDIA H100)
**Depends on:** WO-06 (SEV-SNP smoke passing)
**Blocks:** none (Phase 4 can then start in parallel)
**Owner:** shared library + Python SDK + smoke
**Effort:** ~3 days

## Purpose

Add NVIDIA H100 confidential-mode attestation as the second verified type.
This is the highest-value customer attestation for AI workloads — any
customer running Scruple over inference or training on H100 confidential
GPUs will want it.

## Deliverables

### 1. Verifier plugin

`packages/scruple-attestation-verifiers/src/plugins/nvidia_h100.ts`:

- Parse `attestation_report` as an NVIDIA Attestation JWT.
- Verify JWT signature against NVIDIA's Device Identity Certificate (via `certificate_chain`).
- Verify Device Identity Certificate chains to NVIDIA root CA (pinned in package).
- Verify JWT claims:
  - `nonce` == expected_nonce_hex (bound to leaf preimage)
  - `iat` (issued at) within freshness window
  - `hwmodel` matches an expected H100 model list
  - `gpu_id`, `vbios_version`, `driver_version` present and non-empty
- Return `VerifyResult` with `provider: 'nvidia-h100-cc'`, `gpu_id`, `driver_version`, and any measurement claims.

Reference documentation:
- NVIDIA Attestation SDK (`nvidia-attestation` Python package)
- NVIDIA Trusted Computing whitepaper for H100

### 2. Register in dispatch

`packages/scruple-attestation-verifiers/src/dispatch.ts` imports and registers the plugin.

### 3. Python SDK fetcher

`packages/scruple-sdk-python/scruple/attestation/nvidia_h100_cc.py`:

```python
def fetch(nonce_hex: str) -> AttestationEnvelope:
    """Fetch a fresh NVIDIA H100 CC attestation JWT.

    Requires NVIDIA Attestation SDK installed and CUDA device visible.
    Raises AttestationUnavailable if the host lacks H100 CC support.
    """
    # 1. Import nvidia_attestation (pip install nvidia-attestation)
    # 2. Call nvidia_attestation.attest(nonce_bytes=bytes.fromhex(nonce_hex))
    # 3. Extract JWT + cert chain
    # 4. Construct envelope
```

Handle:
- `nvidia_attestation` not installed → `AttestationUnavailable('NVIDIA Attestation SDK not installed')`
- No H100 detected → `AttestationUnavailable('no H100 confidential-mode GPU present')`
- Attestation call error → `AttestationFetchError(underlying_error)`

### 4. Smoke script

`scripts/smoke-baseline-attestation-nvidia-h100.sh`:

Same shape as WO-06 smoke but for NVIDIA H100. Requires a host with an H100
in confidential mode. Since the AI Council box likely doesn't have an H100,
this smoke may need to run on a rented H100 instance (Modal / RunPod H100
confidential offering).

If no H100 host is available at land time, smoke is marked as PENDING and
the WO is treated as "code shipped, smoke pending H100 access." A stub
smoke that mocks the NVIDIA SDK output (using a captured real JWT) can
land alongside the actual smoke to prove the plugin logic works in unit
tests.

## Acceptance criteria

- [ ] Verifier plugin unit tests pass:
  - Valid captured H100 JWT → `ok: true`, expected `gpu_id`.
  - JWT with mutated payload → `ok: false, error: 'signature invalid'`.
  - JWT with wrong nonce → `ok: false, error: 'nonce mismatch'`.
  - JWT older than freshness window → `ok: false, error: 'attestation stale'`.
- [ ] Python fetcher unit tests pass (with mocked NVIDIA SDK).
- [ ] E2E smoke passes on an H100 host (or is documented as PENDING with a specific host that would run it).

## Notes

- NVIDIA's Device Identity Certificate chain may require caching NVIDIA's
  root CA fetched from their well-known URL. Pin the fetched root PEM in
  the package.
- The NVIDIA Attestation SDK is Python-first; the TS verifier just consumes
  the JWT format. No TS wrapper of NVIDIA SDK is needed.
- Do NOT tie the plugin to a specific H100 model list too tightly — future
  H200 / Blackwell confidential mode should be addable via config, not
  code changes.

## Landing

One commit: `feat(baseline): NVIDIA H100 CC verifier + Python SDK fetcher + smoke stub`.
