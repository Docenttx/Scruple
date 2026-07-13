# WO-04 — AMD SEV-SNP verifier plugin

**Phase:** 2 (SEV-SNP)
**Depends on:** WO-01, WO-03
**Blocks:** WO-05, WO-06
**Owner:** shared library + server plumbing
**Effort:** ~2 days

## Purpose

Ship the first verifier plugin — AMD SEV-SNP — inside the shared verifier
library, and wire the ingest handlers to actually call it. This proves the
plugin dispatch pattern end-to-end. Substantially reuses the existing
SEV-SNP verification code Scruple already uses for its own substrate
attestation (per `docs/l2-evidence/2026-07-12T174954Z/`).

## Deliverables

### 1. Plugin

`packages/scruple-attestation-verifiers/src/plugins/sev_snp.ts`:

```typescript
import type { VerifierPlugin, VerifyResult } from '../verifier.js';
import type { AttestationEnvelope } from '../envelope.js';

export const sevSnpVerifier: VerifierPlugin = {
  attestation_type: 'amd-sev-snp',
  async verify(env, expected_nonce_hex, freshness_max_seconds) {
    // 1. Parse env.attestation_report as SEV-SNP AttestationReport
    //    (1184-byte struct per AMD Firmware ABI Spec v1.55 §7.3)
    // 2. Extract report_data (offset 0x50, 64 bytes; first 32 = binding)
    // 3. Compare first 32 bytes of report_data to expected_nonce_hex bytes
    // 4. Parse env.certificate_chain[0] as VCEK (X.509 DER-encoded)
    // 5. Verify VCEK chains to ASK to ARK (fetch ARK from
    //    https://kdsintf.amd.com/vcek/v1/Genoa/{chip_id} or use pinned copy)
    // 6. Verify VCEK's ECDSA-P384 signature over the report body
    // 7. Verify attestation_time within freshness window
    // 8. Return VerifyResult with cvm_measurement_hex + chip_id
  },
};
```

Reuse code from existing SEV-SNP verifier work — likely `services/witness/`
or `scripts/verify-c2pa-reader.py` (Python) can inform the TypeScript
port. Or wrap the existing Python via `python-shell`.

Pin AMD ARK + ASK PEM into the package (fetched from `kdsintf.amd.com` at
package build time; refreshed manually every 6 months).

### 2. Register plugin in dispatch

`packages/scruple-attestation-verifiers/src/dispatch.ts` imports the plugin
and registers it:

```typescript
import { sevSnpVerifier } from './plugins/sev_snp.js';
registerPlugin(sevSnpVerifier);
```

### 3. Server-side plumbing

Update the shared helper from WO-03 (`lib/baseline/ingest_check.ts`):

- After nonce + freshness checks pass, call `dispatch(envelope, nonce_hex, freshness_max_sec)`
- Set `platform_attestation_verified` based on result:
  - `1` on plugin returning `ok: true` (server-verified)
  - `2` on dispatch identifying it as passthrough with `verifier_reference` (stored, not verified)
  - Reject with 400 if plugin returns `ok: false` (fail closed)
- On plugin exception (e.g., malformed report bytes), log + reject with 400 including the plugin's error message.

### 4. Baseline install path

WO-02's `POST /baseline` and `/rebaseline` also invoke the plugin on the
baseline-time attestation envelope, using the baseline signer's SPKI hash
as the expected nonce. Same success/reject rules.

## Acceptance criteria

- [ ] `pnpm test packages/scruple-attestation-verifiers/test/sev_snp.test.ts` passes with:
  - Valid SEV-SNP report (from `docs/l2-evidence/2026-07-12T174954Z/`) → `ok: true`, correct chip_id + measurement.
  - Mutated report body → `ok: false, error: 'VCEK signature invalid'`.
  - Correct report but wrong nonce → `ok: false, error: 'nonce mismatch'`.
  - Stale attestation_time → `ok: false, error: 'attestation stale'`.
- [ ] Ingest route rejects a witness call with a bad SEV-SNP attestation (returns 400 + clear error).
- [ ] Ingest route accepts and marks `platform_attestation_verified = 1` for a valid attestation.
- [ ] Baseline install rejects with 400 if the baseline's SEV-SNP attestation is invalid.

## Notes

- Do NOT commit any private keys or secrets. Pinned ARK / ASK are public root certs — safe to check in.
- Consider extracting an abstract verifier helper that later NVIDIA/Nitro plugins can share (JWT parsing, cert chain walking, etc.).
- Existing SEV-SNP code from `services/witness/` may be Python; port to TS or shell it. TS is preferred for perf + no subprocess overhead. Only if the port is expensive should we keep it in Python.

## Landing

One commit: `feat(baseline): SEV-SNP verifier plugin + ingest dispatch wiring`. Plugin, dispatch registration, ingest-helper update, tests.
