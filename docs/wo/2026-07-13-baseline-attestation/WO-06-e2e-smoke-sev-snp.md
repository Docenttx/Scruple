# WO-06 — End-to-end smoke: SEV-SNP path

**Phase:** 2 (SEV-SNP)
**Depends on:** WO-01–WO-05
**Blocks:** WO-07 (starts next phase after this smoke green)
**Owner:** integration test
**Effort:** ~1 day

## Purpose

Prove the full round-trip works on the AI Council box (which runs Scruple's
own signer on SEV-SNP): install a baseline, submit witness calls that
auto-include the SEV-SNP attestation, verify server-side, verify CLI-side.
If this smoke passes, the SEV-SNP path is production-ready.

## Deliverables

### Smoke script

`scripts/smoke-baseline-attestation-sev-snp.sh`:

```bash
#!/bin/bash
# 1. Provision a test tenant (test-tenant-1)
# 2. Generate an ES256 baseline signing keypair (openssl)
# 3. Write a scruple-baseline.yaml declaring:
#    - a small set of test code files
#    - attestation.provider: amd-sev-snp
# 4. Fetch a fresh SEV-SNP attestation binding the pubkey SPKI hash
# 5. POST /baseline with the manifest + attestation
# 6. Assert 200 + baseline_hash returned
# 7. GET /baseline/current — assert matches
# 8. Submit a witness call (POST /witness/cad or similar):
#    - X-Baseline-Hash header set
#    - platform_attestation envelope in body (fresh, nonce = leaf preimage hash)
# 9. Assert 200 + platform_attestation_verified = 1
# 10. Submit a second witness call with a STALE attestation (fake old timestamp)
#     - Assert 400 + error mentions freshness
# 11. Submit a third witness call with a mutated report body
#     - Assert 400 + error mentions signature/verification
# 12. Submit a fourth call with WRONG X-Baseline-Hash
#     - Assert 409 + error mentions baseline mismatch
# 13. Run scruple-verify CLI (once WO-13 lands) on one of the receipts
#     - Assert exits 0 + validates both integrity + SEV-SNP attestation
# 14. Cleanup: delete test tenant
```

For WO-06, steps 1–12 must all pass. Steps 13 is deferred to WO-13.

### Test data

Include a fixture `scripts/smoke-fixtures/sev-snp/` with:
- Sample code files (small dummies)
- Sample baseline manifest
- Expected baseline hash (computed at fixture creation, verified in smoke)

## Acceptance criteria

- [ ] Smoke runs to completion on the AI Council box (which has SEV-SNP).
- [ ] All 12 assertions pass.
- [ ] Total runtime under 60 seconds.
- [ ] Smoke can be re-run repeatedly (idempotent tenant cleanup).
- [ ] Smoke output is machine-parseable (each assertion prints `PASS:` or `FAIL:` prefix).
- [ ] Add smoke to a Makefile target `make smoke-baseline-sev-snp` for repeatability.

## Notes

- Do NOT run against the production witness server. Point at a local dev
  instance (dev.scruple.ai or localhost:3000) with a test-only tenant.
- The SEV-SNP attestation fetch requires the box to have `/dev/sev-guest`.
  Confirm before running; skip cleanly with a WARN if not present.
- If any assertion fails, dump the request/response to a debug log for
  post-mortem.

## Landing

One commit: `test(baseline): E2E smoke — SEV-SNP baseline install + witness + reject cases`. Smoke script + fixtures.

## Phase 2 exit gate

Once this smoke goes green:
- Update memory noting Phase 2 complete.
- Proceed to WO-07 (NVIDIA H100).
