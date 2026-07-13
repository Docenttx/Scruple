# Baseline + Attestation Import — WO Index

**Start here:** [`WORK_ALLOCATION_PLAN.md`](./WORK_ALLOCATION_PLAN.md) for phase structure + dependency graph.

## Phase 1 — Foundation
- [WO-01 — Baseline data model + envelope schema + verifier lib skeleton](./WO-01-foundation.md)
- [WO-02 — Baseline API endpoints](./WO-02-baseline-api.md)
- [WO-03 — Ingest baseline ref + freshness window](./WO-03-ingest-baseline-ref.md)

## Phase 2 — SEV-SNP (first verifier)
- [WO-04 — AMD SEV-SNP verifier plugin](./WO-04-sev-snp-verifier.md)
- [WO-05 — Python SDK baseline + SEV-SNP fetcher](./WO-05-sdk-python-baseline.md)
- [WO-06 — E2E smoke: SEV-SNP path](./WO-06-e2e-smoke-sev-snp.md)

## Phase 3 — NVIDIA H100
- [WO-07 — NVIDIA H100 CC verifier + SDK fetcher + smoke](./WO-07-nvidia-h100.md)

## Phase 4 — Remaining verifiers (parallelizable)
- [WO-08 — AWS Nitro Enclave verifier + fetcher](./WO-08-aws-nitro.md)
- [WO-09 — Azure Attestation Service (MAA) verifier + fetcher](./WO-09-azure-maa.md)
- [WO-10 — Intel TDX verifier + fetcher](./WO-10-intel-tdx.md)
- [WO-11 — TPM 2.0 Quote verifier + fetcher](./WO-11-tpm-2.md)
- [WO-12 — Passthrough handling](./WO-12-passthrough.md)

## Phase 5 — Reference verifier CLI
- [WO-13 — CLI baseline + attestation re-verification](./WO-13-cli.md)

## Phase 6 — Baseline lifecycle + public transparency
- [WO-14 — Re-baseline endpoint + auto-rebaseline](./WO-14-rebaseline.md)
- [WO-15 — Baseline chain-lock + public registry](./WO-15-baseline-chain-lock.md)
- [WO-16 — CI drift check](./WO-16-ci-drift.md)
