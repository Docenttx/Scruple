# Baseline + Attestation Import — Work Allocation Plan

**Created:** 2026-07-13
**Owner:** Docent Technologies LLC (dba Scruple)
**Implements:** [`SCRUPLE_STANDARD_v1.md`](../../architecture/SCRUPLE_STANDARD_v1.md) v1.2 §15 and [`SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md`](../../architecture/SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md) v1.2 §§2–4 (P7, P8).

## Purpose

Ship the baseline-attestation mechanism end-to-end: an integration's tamper-surface becomes a signed baseline, every witness leaf references that baseline, and any tamper-surface change either verifies against the baseline or surfaces as a re-baseline event. Additionally: import customer hardware attestation (NVIDIA H100, SEV-SNP, TDX, Nitro, MAA, TPM) into leaves so receipts commit to hardware-rooted compute as well as to the integration.

## The six phases

### Phase 1 — Foundation (must land first)

Blocking everything else. Establishes the data model, envelope schema, and shared verifier library that both server and CLI import.

- **WO-01** — Baseline data model + migration + envelope schema + shared verifier library skeleton
- **WO-02** — Baseline API endpoints (`POST /baseline`, `POST /rebaseline`, `GET /baseline/current`, `GET /baseline/history`, `POST /baseline/verify`)
- **WO-03** — Baseline reference on witness ingest + freshness window enforcement

### Phase 2 — SEV-SNP (prove the pattern, first verifier)

Reuses existing SEV-SNP work from Scruple's own substrate. Landing this proves the whole plugin pattern.

- **WO-04** — AMD SEV-SNP verifier plugin (in shared library)
- **WO-05** — Python SDK: baseline machinery (manifest reader, hash computation, SEV-SNP fetcher, envelope construction, auto-injection)
- **WO-06** — End-to-end smoke: SEV-SNP baseline install + witness call + verification, both server-side and via CLI

### Phase 3 — NVIDIA H100 (highest customer value)

The AI-workload attestation format. Ships second because it's the most requested; independent of Phase 4.

- **WO-07** — NVIDIA H100 confidential mode verifier plugin + SDK fetcher + smoke

### Phase 4 — Remaining verifiers (parallelizable)

Each adds one attestation format. Any can be worked in parallel once Phase 2 is done.

- **WO-08** — AWS Nitro Enclave verifier + SDK fetcher
- **WO-09** — Azure Attestation Service (MAA) verifier + SDK fetcher
- **WO-10** — Intel TDX verifier + SDK fetcher
- **WO-11** — TPM 2.0 Quote verifier + SDK fetcher
- **WO-12** — Passthrough handling for uncommon `attestation_type` values with `verifier_reference`

### Phase 5 — Reference verifier CLI

Ships the shared verifier library through the customer-runnable CLI so anyone can independently re-verify a receipt's attestations.

- **WO-13** — CLI baseline verification + attestation re-verification via shared library

### Phase 6 — Baseline lifecycle + public transparency

Completes the end-to-end story: re-baselining flow, auto-detection of drift, and public-ledger anchoring of baseline events.

- **WO-14** — Re-baseline endpoint + audit chaining + auto-rebaseline SDK behavior
- **WO-15** — Baseline chain-lock + public baseline registry (`/api/v1/registry/baselines/{scrId}`)
- **WO-16** — CI drift check (fails PR if a P1/P2 file changes without a re-baseline decision)

## Dependency graph

```
WO-01 (foundation)
  ├─→ WO-02 (baseline API)
  │     ├─→ WO-03 (ingest ref + freshness)
  │     │     └─→ WO-04 (SEV-SNP verifier)
  │     │           └─→ WO-05 (SDK baseline + SEV-SNP fetcher)
  │     │                 └─→ WO-06 (E2E smoke SEV-SNP)
  │     │                       └─→ WO-07 (NVIDIA H100)
  │     │                             ├─→ WO-08 (AWS Nitro)      \
  │     │                             ├─→ WO-09 (Azure MAA)       \
  │     │                             ├─→ WO-10 (Intel TDX)        parallel
  │     │                             ├─→ WO-11 (TPM 2.0)         /
  │     │                             └─→ WO-12 (passthrough)   /
  │     │                                   └─→ WO-13 (CLI)
  │     └─→ WO-14 (re-baseline)  ─→ WO-15 (chain-lock/registry) ─→ WO-16 (CI drift)
```

## Effort estimates (rough)

| Phase | WOs | Estimated effort |
|---|---|---|
| Phase 1 | 3 | 1 week |
| Phase 2 | 3 | 1 week |
| Phase 3 | 1 | 2–3 days |
| Phase 4 | 5 | 1 week (parallelizable to 2–3 days) |
| Phase 5 | 1 | 2 days |
| Phase 6 | 3 | 1 week |
| **Total** | **16** | **4–5 weeks** wall time; less if verifiers parallelize |

## Ownership

All work lands in `/data/scruple-web`. Layering:

- **Server routes** (`app/api/v1/baseline/*`, ingest updates) — Next.js API routes, TypeScript
- **Shared verifier library** (`packages/scruple-attestation-verifiers/`) — TypeScript for v1 to match ecosystem; Rust migration deferred to a later WO if perf-critical
- **Python SDK** (`packages/scruple-sdk-python/`) — new package; per-vendor fetchers as submodules
- **CLI** (`packages/scruple-verify/`) — existing Node CLI; extended to import the shared verifier library
- **DB migrations** — SQLite for now (existing pattern), Postgres migration deferred

## Landing discipline

- Every WO lands its own commit (or small commit series). No mega-commits.
- Every WO includes tests (unit for verifiers, integration for API routes, E2E for smokes).
- Each phase completion updates memory with what shipped + what's pending.
- Do not proceed to Phase N+1 until Phase N smoke passes on the AI Council box.

## Non-goals for this WO set (deferred)

- Postgres migration of the baseline / attestation tables (design later)
- Rust rewrite of the shared verifier library (design later — TypeScript is fine for v1)
- Receipt UI updates to render baseline + attestation chains (separate WO set — belongs with the customer-facing receipt page work)
- Prepare/commit two-phase pattern for gating events (Standard §§12–14 reserved; separate WO set)
- Admin dashboard for baseline management (post-v1)
- Rate limits / DoS protection on baseline endpoints (post-v1)
