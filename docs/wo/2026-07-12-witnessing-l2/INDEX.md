# Work Orders — Scruple Witnessing & C2PA L2

**Canonical design:** `docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md`
**Created:** 2026-07-12
**Purpose:** Execution plan for standing up L2-grade C2PA signing + the
Continuous Audit API + Rider-compliant witnessing, in one build. Sprint 1
target: **vendor-demoable within 5–7 days.**

## L2 evidence path (added 2026-07-12 after C2PA GPSR research)

**Not in the original sprint plan.** Corrects the earlier assumption
that L2 required a $1,800/mo physical HSM. C2PA GPSR §6.1.2 + §6.2.2
are satisfied by AMD SEV-SNP attestation + SoftHSM in an OCI CVM at
~$1/evidence-run + ~$120/mo when active. See canonical §18 and
`WO-CVM-01-l2-evidence-path.md`.

| WO | Title | Blocking | Owner-hours |
|---|---|---|---|
| [WO-CVM-01](WO-CVM-01-l2-evidence-path.md) | SoftHSM in SEV-SNP CVM — signer backend + evidence-run playbook + verifier attestation subcommand | Nothing for code. Live run needs user to `oci compute instance launch` on demand | 8h code + ~2h live run |

## Sprint layout

| Sprint | Target window | Deliverable | WOs |
|---|---|---|---|
| **1 — Vendor-demoable core** | 5–7 days from 2026-07-12 | End-to-end: sign asset → leaf → checkpoint → offline-verify with `scruple-verify c2pa` | WO-01 through WO-10 |
| **2 — Rider compliance + timestamps** | Weeks 2–3 | Qualified TSA, super-root anchoring, principal onboarding, SDK publish | WO-11 through WO-15 |
| **3 — Evidence + polish** | Weeks 3–4 | CI gate, lifecycle docs, L2 evidence package, Conformance submission | WO-16 through WO-18 |
| **4 — Escalation (flagged)** | Weeks 4–8 | Rules engine + LLM triage + preservation directive | WO-19 through WO-21 |

## Dependency graph (Sprint 1)

```
                   WO-02 (cert app — long lead time, EXTERNAL)
                       │
                       │ (chain used at WO-08 for prod cert; dev cert until then)
                       ▼
    WO-01 (Vault) ──► WO-03 (signer refactor) ──► WO-04 (isolation)
                                                        │
                                                        │ (signer daemon ready)
                                                        ▼
    WO-05 (schema) ──► WO-06 (ingest API) ──► WO-07 (checkpoints) ──► WO-08 (C2PA emits)
                                                                              │
                                                                              ▼
                                                        WO-09 (verify CLI) ──► WO-10 (E2E smoke)
```

- **WO-01, WO-02, WO-05** can start immediately in parallel.
- **WO-03** blocks on WO-01.
- **WO-04** blocks on WO-03.
- **WO-06** blocks on WO-05.
- **WO-07** blocks on WO-06 (needs `log_leaves`) and WO-01 (needs checkpoint key).
- **WO-08** blocks on WO-04 (isolated signer) + WO-06 (ingest available).
- **WO-09** can start alongside WO-05 (canonical leaf spec is enough to draft);
  final validation needs WO-07 output.
- **WO-10** is a smoke gate; runs when WO-01–09 are green.

## Sprint 1 work orders

| WO | Title | Blocking | Owner-hours (est.) | Status |
|---|---|---|---|---|
| [WO-01](WO-01-oci-vault-provisioning.md) | OCI Vault provisioning (both keys + IAM + audit archive) | none | 6h | pending |
| [WO-02](WO-02-c2pa-cert-application.md) | C2PA production cert application (external, long lead time) | WO-01 (needs public key from Vault) | 4h submit + weeks wait | pending |
| [WO-03](WO-03-signer-refactor.md) | Refactor `sign.py` to `Signer.from_callback` via OCI Vault | WO-01 | 8h | pending |
| [WO-04](WO-04-signer-isolation.md) | systemd unit + dedicated OS user + Unix socket transport + rate limits | WO-03 | 6h | pending |
| [WO-05](WO-05-audit-api-schema.md) | Migration 022 (tenants, principals, delegations, streams, log_leaves, checkpoints, anchor_epochs) + canonical leaf v23 module + parity tests | none | 10h | pending |
| [WO-06](WO-06-audit-api-ingest.md) | `POST /v1/log/{stream}` + `/batch` + `POST /v1/streams` + HMAC middleware + rate limiting | WO-05 | 10h | pending |
| [WO-07](WO-07-checkpoint-service.md) | BullMQ scheduler + balanced Merkle + Ed25519 signing via Vault + heartbeats + consistency chain | WO-06, WO-01 | 12h | pending |
| [WO-08](WO-08-c2pa-emit-leaf.md) | C2PA signer emits sign event to `scruple.c2pa.sign` stream; correlation surfaced in `/api/scruple/c2pa/sign` response | WO-04, WO-06 | 6h | pending |
| [WO-09](WO-09-verify-cli-v1.md) | `scruple-verify` CLI v1: `leaf`, `c2pa`, `trust-manifest` subcommands + `--offline` mode | WO-05 (spec), WO-07 (output shape) | 12h | pending |
| [WO-10](WO-10-sprint1-e2e-smoke.md) | End-to-end smoke: sign asset → check leaf appears → wait for checkpoint → run `scruple-verify c2pa` → publish demo script | WO-01–09 all green | 4h | pending |

**Sprint 1 total: ~78 owner-hours** (~10 days at 8h/day for a single implementer,
or ~5 days at 16h/day sustained for two parallel tracks). WO-02's external
wait does not block anything in Sprint 1 that can't be done with a dev cert
and re-run once the prod cert lands.

## Sprint 2 work orders (planned; details land at sprint start)

| WO | Title | Blocking | Owner-hours (est.) |
|---|---|---|---|
| [WO-11](WO-11-rfc3161-tsa.md) | RFC 3161 client + qualified TSA vendor procurement + retry queue | WO-07 | 12h |
| [WO-12](WO-12-anchor-super-root.md) | Super-root scheduler + wire to existing RVN/IPFS/Arweave pipeline | WO-07 | 10h |
| [WO-13](WO-13-proof-api-full.md) | `/v1/proof/consistency/*` + full `/v1/principal/*` endpoints + async export job | WO-07, WO-12 | 12h |
| [WO-14](WO-14-principal-onboarding.md) | Principal invite flow: vendor invites → witness mints read-key directly to principal contact | WO-05, WO-13 | 10h |
| [WO-15](WO-15-sdk-publish.md) | `@scruple/log` npm package + canonicalization parity contract + demo tenant | WO-05, WO-06 | 8h |

**Sprint 2 total: ~52 owner-hours**

## Sprint 3 work orders (planned)

| WO | Title | Blocking | Owner-hours (est.) |
|---|---|---|---|
| [WO-16](WO-16-ci-conformance-gate.md) | `.github/workflows/c2pa-conformance.yml`: manifest round-trip + interop against c2pa-python/c2pa-node/c2patool + audit-trail verify via `scruple-verify c2pa` | WO-08, WO-09 | 8h |
| [WO-17](WO-17-lifecycle-docs.md) | `docs/architecture/lifecycle/{key-generation,key-rotation,key-revocation,incident-response}.md` + `docs/architecture/security-policy.md` | none | 12h |
| [WO-18](WO-18-l2-evidence-package.md) | Interop test v2 (production path) + evidence bundle assembly + Conformance Program submission | WO-02 landed, WO-16, WO-17 | 8h |

**Sprint 3 total: ~28 owner-hours** (much of Sprint 3 is docs + evidence
assembly; unblocks once WO-02 issuer lead time clears).

## Sprint 4 — Phase 2 (flagged, deferred)

| WO | Title | Blocking |
|---|---|---|
| [WO-19](WO-19-escalation-rules.md) | Deterministic rules engine + `_scruple.escalations` reserved stream + preserve_in_place directive | Sprint 3 done |
| [WO-20](WO-20-llm-triage-worker.md) | LLM triage worker in `customer_perimeter` deployment mode | WO-19 |
| [WO-21](WO-21-preservation-protocol.md) | Preservation directive protocol: server issues directive, vendor SDK writes to customer WORM, returns `{preservation_hash, storage_ref}` | WO-19, WO-15 |

## Global invariants across all WOs

Enforce in code review; violation = block.

1. **No raw private key material in any process memory except OCI Vault.**
   Vault callback style for both signing keys.
2. **No content ever written to any Docent-side table.** Only hashes,
   signatures, timestamps, anchor references. Ingest schema rejects
   `payload_bytes` on all streams except the specific escalation preservation
   path in Phase 2 (Sprint 4).
3. **Every mutation to `log_leaves` / `checkpoints` / `anchor_epochs` is
   append-only.** No UPDATE / DELETE code paths without an ADR + counsel review.
4. **Canonical leaf parity between SDK and server is a unit-test gate.**
   Any change to canonicalization touches both call sites + parity test.
5. **Principal read endpoints must function with the tenant absent or
   adversarial.** Auth scopes strictly on principal read-key; no
   tenant-secret checks in that path.
6. **Rate limits + backpressure on every ingest endpoint.** No unbounded queues.

## Status tracking

Update the "Status" column in the Sprint tables above as WOs move from
`pending` → `in progress` → `done`. Each WO file has its own
"Acceptance criteria" section that is the gate for marking `done`.

## Non-compaction-loss discipline

If a future Claude Code session picks this up cold:

1. Read this INDEX.md first (in `docs/wo/2026-07-12-witnessing-l2/`).
2. Read `docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md` for the
   design.
3. Then read the individual WO file for whatever's next.
4. The canonical design doc §14 lists the load-bearing decisions that
   should NOT be re-derived.
