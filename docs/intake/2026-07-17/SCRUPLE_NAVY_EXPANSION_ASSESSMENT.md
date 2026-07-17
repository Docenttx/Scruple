# SCRUPLE_NAVY_EXPANSION_ASSESSMENT

**Source WO:** `SCRUPLE_CC_NAVY_DESIGN_WORK_ORDER.md` (Topic DON26BZ03-NV059, NAVSEA)
**Scope:** repository audit only. No claims about the FPGA product line beyond what the WO states.
**Grading (maturity):** SHIPPED = code exists and is exercised; BUILD = code exists, not exercised end-to-end; CONCEPT = documented only. UNVERIFIED = cannot confirm from the repo.
**Rule observed:** no timeline language. Strategic choices flagged for the operator; not resolved.

---

## Lane taxonomy (used throughout)

The WO fixes Scruple's remit at the outset (Part 1, plane 4 + Part 2 preamble): *the fabric writes the chain in RTL; Scruple defines the record schema, the chain discipline, the verifier tooling, and the anchoring/replication protocol.* Every finding below is tagged against three lane categories independent of the SHIPPED/BUILD/CONCEPT maturity grade:

- **In lane** — falls within Scruple's four-part remit above. Scruple can be proposed as delivering this end-to-end.
- **Adjacent (integration surface)** — Scruple provides part of the capability; another subsystem (fabric RTL, hardware attestation source, external standards body, transport stack) provides the rest. Proposal shape: *"Scruple ledgers what partner X produces / decides,"* not *"Scruple delivers the whole capability."*
- **Out of lane** — the mechanism belongs to a different subsystem entirely. Only the *design pattern* transfers — do not propose Scruple code as fulfilling it. Reference the pattern as a precedent; do not source-repurpose.

Two claims deserve callouts up front, because they set the shape of every gap answer:

- Scruple **CAN deliver** ledger schema, chain discipline, verifier tooling, cross-anchor / peer-replication protocol, revocation-list schema, PQ algorithm addition, and all associated M&S automation — every item on that list is inside its remit. When code isn't there yet it's BUILD, but it's BUILD *in lane*.
- Scruple **CANNOT deliver** transport-layer channel-bound identity (SPIFFE / mTLS / TLS-exporter binding), the hardware fail-open decision itself, and the RTL implementation of the ledger. These are adjacent subsystems by the WO's own division of labor. Scruple *witnesses* what they do; it does not *become* them.

---

## PART A. Role validation (R-A through R-E)

### R-A. Access-event ledger schema

**Vector:** SHIPPED with a mechanical schema fork.
**Lane:** entirely in-lane — schema is Scruple's core remit.

Scruple's v2.4 canonical leaf preimage is fixed-order over `{tenant_id, principal_id, stream_id, tenant_seq, event_time, payload_hash, workflow_hash, machine_manifest_hash, dims}` at `lib/witness/canonicalLeafV24.ts:48-58`, with a byte-parity Python twin at `services/witness/canonical_leaf_v24.py`. Chain hash is `sha256(prev_chain_hash_bytes || leaf_hash_bytes)` (`canonicalLeafV24.ts:110-120`).

Mapping to a Navy access-event `{principal, device, resource, decision, assurance, gate window, timestamp}`:

| Access-event field | Scruple field | Grade | Notes |
|---|---|---|---|
| principal | `principal_id` | SHIPPED | Untyped `TEXT`; already first-class. `principalForUser.ts` mints one per user. |
| resource | `stream_id` or `payload_hash` | SHIPPED (partial) | See open question 1. |
| device | `dims` today; first-class in v2.5 | BUILD | `dims` values are constrained to `sha256:<64hex>` (`ingest.ts:204-209`); `device_hash` dim works now; first-class `device_id` needs a leaf-scheme bump per the version discipline at `canonicalLeafV24.ts:30-37`. |
| decision (allow/deny) | `meta_json` today; first-class in v2.5 | BUILD | Free JSON blob with PII denylist (`ingest.ts:27,246-250`); promotion is mechanical. |
| assurance level | `meta_json` today; first-class in v2.5 | BUILD | Same treatment. |
| gate window | `dims` (start/end sha256) or `meta_json` | BUILD | Raw timestamps land in `meta_json` unless canonicalized+hashed. |
| timestamp | `event_time` (RFC3339 UTC) + server `received_at` | SHIPPED | Two-timestamp discipline enforced at ingest (`030_scruple_log.sql:88`). |

**Untouched by inversion:** field-order + JSON encoding rules (`canonicalLeafV24.ts:22-28`), leaf preimage → sha256 → chain_hash, per-stream `tenant_seq` monotonicity + gap detection (`ingest.ts:284-290`), idempotency (`ingest.ts:277-282`), balanced-Merkle checkpoint scheduler (`checkpointScheduler.ts:141-153`). All in lane.

**Changed by inversion:** the semantic layer only. A v2.5 preimage with promoted `device_id`, `verdict`, `assurance_level`, `gate_window_id` is a parallel-module fork per the leaf-scheme version discipline — same shape as the shipped v2.3 → v2.4 transition. BUILD, in lane.

**Cross-repo, in-lane schema transfer:** Stooges Junior `rubric_verdicts` (`ai-council/lib/db/migrations/091_sj_rubric_verdicts.sql:14-49`) is the strongest existing analog to a Navy access-decision leaf. Fields already read as `{principal, resource-binding, verdict-class, content_hash, assurance-snapshot, policy-version, matched-layer, matched-category, final_disposition, confidence, evidence-links, actor-model, actor-latency, actor-raw-response}`. Substitute `kid_user_id → principal_id`, `age_band_at_time → assurance_level`, `rubric_version_id → policy_version`, `final_disposition → verdict`, and every column has a Navy target. SHIPPED, live at `junior.stooges.ai`, writer path at `ai-council/lib/conductor/juniorLog.ts:22-52`. The *schema* is in-lane pattern transfer to Scruple; the *writer path* stays in the SJ application.

Stooges' `audit_decisions` + `audit_anomalies` (`ai-council/lib/db/migrations/037_audit_log.sql:19-46`) are a coarser second precedent. Migration comment 037:6-9 explicitly flags the hash-chain extension (planned, unbuilt) — in-lane by intent.

### R-B. Provisioning custody ledger

**Vector:** SHIPPED for the ceremony schema and chain discipline. FPGA-specific attestation plugin is adjacent.
**Lane:**
- *In lane:* baseline chain schema, `insertRebaseline` atomicity, offline baseline verifier, custody-history endpoint, per-provisioning nonce discipline, and cross-repo record-schema patterns (SJ `child_links`, Stooges `mobileTokens` enrollment).
- *Adjacent (integration surface):* FPGA-flavor attestation plugin — Scruple defines the envelope slot and re-verifies the evidence, but the *quote generation* is a fabric-silicon function performed by the partner. Contract: Scruple = envelope schema + verifier; partner = quote producer.
- *Out of lane:* nothing here.

Existing in-lane machinery:

- **Ceremony record.** `scruple-baseline.yaml` at repo root captures `integration_id`, `version`, `code:` globs → SHA-256 per file, `dependencies:` globs, `deployment.service_units:` systemd files, `config.env:` (name + secret handle), and `attestation.provider`. `packages/scruple-sdk-python/scruple/baseline.py:159-222` computes `baseline_hash = sha256(canonical(blob))` where blob includes `signer_pubkey_spki_sha256_hex`. SHIPPED.
- **Chain semantics.** `lib/db/migrations/032_baselines.sql:17-40` — `baselines(id, tenant_id, baseline_hash, prev_baseline_hash, manifest_json, attestation_provider, attestation_envelope_json, signer_pubkey_spki_sha256_hex, reason, submitted_at, activated_at, retired_at, witness_leaf_id)` + `tenant_current_baseline`. `lib/baseline/dao.ts:136-208` `insertRebaseline()` enforces `prev_baseline_hash` matches current, atomically retires old + activates new. SHIPPED.
- **Public custody-history endpoint.** `app/api/v1/registry/baselines/[tenant]/history/route.ts` walks the chain to genesis. SHIPPED.
- **Offline verifier.** `packages/scruple-verify/src/baseline_verify.mjs` re-walks each `prev_baseline_hash` back to null-genesis. SHIPPED.
- **Per-provisioning nonce discipline.** At baseline time `nonce = SHA-256(SPKI hash of the baseline signing key)` (`SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md:260-262`); at witness time nonce binds the leaf preimage. Ceremony-per-event is native.

Adjacent (integration surface):

- **Attestation envelope registry** `packages/scruple-attestation-verifiers/src/envelope.ts:11-19` ships `amd-sev-snp, intel-tdx, aws-nitro-enclave, gcp-confidential-space, azure-attestation-service, nvidia-h100-cc, tpm-2.0-quote` plus passthrough `verifier_reference: <https-url>` (`envelope.ts:99-115`). A new `fpga-<vendor>-<flavor>` plugin fits the shape at `packages/scruple-attestation-verifiers/src/plugins/` — the registry auto-dispatches (`dispatch.ts:36-42`). BUILD (in Scruple), but the plugin *verifies* what fabric silicon *produces* — the fabric side is a partner deliverable. Contract line: Scruple accepts the vendor's quote format and re-verifies it against the trust manifest; the vendor delivers the quote generator and its evidence bytes.

Cross-repo in-lane schema:

- **SJ `child_links`** (`ai-council/lib/db/migrations/096_sj_parent_linkage.sql:30-64`) is a working device-provisioning receipt with ceremony evidence attached (`attestation_token_hash` = SHA-256 of the inbound HMAC token), plus revocation columns (`revoked_at`, `revoked_reason`) and a unique index on the pair. Receiving side `app/api/junior/claim-child/route.ts:1-126`; sending side `app/api/family/provision-child/route.ts:1-111`. SHIPPED. Schema pattern transfers directly to Scruple as an in-lane baseline-supplement.
- **Stooges `mobileTokens`** (`ai-council/lib/auth/mobileTokens.ts` + `migrations/103_mobile_user_tokens.sql`) — one-time enrollment token, hashed at rest, 24 h TTL, single-use with `consumed_at` + `consumed_by_token_id` provenance; on consume, server mints access + refresh pair, hashed at rest, with `device_info` fingerprint and `enrolled_by_user_id` provenance. SHIPPED. Same in-lane pattern.

**Open item.** Scruple baselines are integration-scoped, not device-scoped. Per-device custody either explodes tenant count or promotes `device_id` to a leaf-first-class field (v2.5 bump). See open question 2. In lane either way.

### R-C. Cross-node anchoring + checkpoint distribution

**Vector:** single-node witness SHIPPED; peer topology is genuinely new work; the anchor-to-N-authorities pattern that would drive peer anchoring is SHIPPED against external ledgers.
**Lane:**
- *In lane:* everything on the current single-witness path (anchor pipeline, deferred anchoring, trust-manifest publication, super-root scheduler when built, peer-to-peer replication protocol when built, quorum witness signing when built, split-brain reconciliation when built). All within Scruple's "anchoring/replication protocol" remit.
- *Adjacent:* nothing here — the pipeline endpoints (RVN, IPFS, Arweave, or peer nodes) are external, but Scruple's *side* of every one of those interfaces is in-lane.
- *Out of lane:* the underlying network transport itself (TLS, TCP, physical links). Scruple defines what goes over it, not what carries it.

Existing:

- **Anchoring pipeline (single-witness → public ledgers).** `/opt/scruple-witness/server.js:263-311` `anchorPermanence()` posts to RVN testnet (`testnet-locker.js:44`), IPFS (`ipfs-pinner.js`), and Arweave (`arweave-treasury.js`). Non-fatal COALESCE semantics — partial anchor sets are valid, retries monotonically complete (`server.js:258-262`). SHIPPED, in lane.
- **Deferred anchoring.** Witness accumulates leaves + checkpoints locally in SQLite (`log_leaves`, `log_checkpoints` in `030_scruple_log.sql`); anchoring runs on a separate scheduler. Two-tier structure (leaf → per-stream checkpoint → cross-stream super-root → public ledger) designed and partially wired: `anchor_epochs` table exists (`030_scruple_log.sql:121-129`); super-root builder described in `docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md:305-318`; super-root scheduler is BUILD in lane (`app/api/v1/proof/leaf/[stream_name]/[tenant_seq]/route.ts:143-148` returns `super_root: null` today).
- **Trust-manifest publication.** `app/.well-known/witness-trust.json/route.ts` — pull-mode distribution channel. SHIPPED as pull, in lane. Push replication is BUILD in lane.
- **Chain replication / cluster awareness.** None. `app/api/fusion/handoff/route.ts:21` and `app/api/diag/fusion/route.ts:21` acknowledge single-node. BUILD in lane.
- **Anchor-to-N-independent-authorities pattern.** Shipped RVN + IPFS + Arweave triple anchoring IS the "cross-anchor to N independent authorities" pattern. Substitute peer nodes for external ledgers and the discipline (post super-root, retries monotonically complete, COALESCE partial acceptance) transfers directly to a cross-enclave-node anchoring topology. In lane, CONCEPT for the substitution.

Cross-repo, in-lane (only production cross-node primitive in tree):

- **SJ ↔ Stooges HMAC-attested channel** (`ai-council/lib/sj/attestation.ts:1-207`). Every call from `app.stooges.ai/api/family/child/[id]/audit` to `junior.stooges.ai/api/junior/log/[childId]` carries an `x-sj-s2s-sig` HMAC signature over `method\npath\nts\nsha256(body)` with 300 s clock-skew tolerance. Two independent DBs cryptographically bound per request; receiver validates application-level authorization (`child_links.revoked_at IS NULL`, parent-owns-child) after HMAC verify. SHIPPED. **The lane call is subtle:** the code lives in an application (SJ), but the *pattern it implements* — two independent enclaves, per-request cryptographic binding, local policy-consistency check on receipt — is precisely the anchoring/replication-protocol pattern Scruple needs at witness-node granularity. Reimplemented at Scruple's witness layer it is in-lane BUILD.

Cross-repo distant analog:

- **Stooges `bundle.ts`** (`ai-council/lib/sharing/bundle.ts:1-120`) packs a Production subtree with `BUNDLE_FORMAT_VERSION`. Checkpoint-distribution primitive shape, out-of-lane code (application-scoped), in-lane pattern (portable signed bundle).

**Not present anywhere, in-lane BUILD:** peer-to-peer distribution protocol, signed CRL/trust-manifest transport on the same channel, disconnected-node reconciliation on rejoin, quorum witness signing.

### R-D. Verifier + audit tooling

**Vector:** medium maturity, additive gaps for a Navy after-action workflow.
**Lane:** entirely in-lane — verifier tooling is a literal WO remit item.

Two verifiers coexist in `/data/scruple-web/`:

1. **`scripts/audit-receipts.py`** (386 lines) — full-spectrum audit script that re-derives every hash from raw fields for every project across 5 workflow modes, cross-checks against web DB + witness DB + HTML receipt + journalctl. 13-24 checks per project (`audit-receipts.py:174-368`). SHIPPED. In lane.

2. **`packages/scruple-verify` npm CLI** (`cli.mjs`, 288 lines) — subcommands `leaf | baseline | watermark | attestation | full`. Offline-capable given proof file + trust manifest (`cli.mjs:76-85`). Verifies leaf-hash re-derivation with v2.3/v2.4 dispatch, workflow-hash re-derivation from raw JSON when attached, Merkle inclusion path → checkpoint merkle_root, Ed25519 signature over canonical checkpoint bundle, baseline chain integrity, platform-attestation via the shared plugin library. Anchor step stubbed (`cli.mjs:225-230`). SHIPPED. In lane.

**Trust manifest** at `app/.well-known/witness-trust.json/route.ts` publishes algorithm-tagged signer set with `activated_at`/`deprecated_at`. Verifier honors `deprecated_at` (warns but accepts, `cli.mjs:108-111`). SHIPPED. In lane.

**In-lane BUILD items** to close the shore-side after-action workflow:
- Consistency proofs between two epochs (designed at `CANONICAL_SCRUPLE_WITNESSING_L2.md:334`).
- Bulk-chain-fetch tarball / `--offline` bundle subcommand.
- Signed trust-manifest history for "at epoch X, key Y was valid signer" queries.
- Air-gap-safe verifier package (single-binary; `audit-receipts.py` proves a Python re-implementation is available).
- Anchor verification for peer super-roots (once R-C peer topology exists).

Cross-repo, in-lane patterns:

- **Stooges `auditor.ts` silent conductors** (`ai-council/lib/conductor/auditor.ts:1-399`) — "auditor observes, records, never intervenes" pattern. Code out-of-lane (application-scoped Node runtime). Pattern in-lane: verifier discipline that emits without altering the audited surface.
- **Stooges `middleware.ts:1-80`** — edge-resident, JWT-only auth gate. Code out-of-lane (web middleware). Pattern in-lane: signed-capability enforcement without upstream DB round-trip — directly informs an edge-verifier at a Navy node consuming a cached signed CRL.
- **SJ `app/api/junior/log/[childId]/route.ts:1-80`** — HMAC-authenticated read-back endpoint for the child's decision log. Closest existing shore-auditor-shape endpoint in tree. Code out-of-lane; endpoint pattern in-lane.

### R-E. Post-quantum posture

**Vector:** no PQ primitives today; hybrid ML-DSA signer is BUILD-viable via existing callback seams.
**Lane:**
- *In lane:* signature algorithm choice for checkpoints, hash algorithm choice for leaf/chain/Merkle, trust-manifest algorithm tagging, verifier algorithm dispatch. All within chain-discipline + verifier-tooling remit.
- *Adjacent (external standards constraint):* C2PA signer path — the C2PA spec itself does not currently admit ML-DSA; whether Scruple's Navy leg must be C2PA-compliant is an integration decision, not a Scruple crypto decision. Open question 3.
- *Out of lane:* nothing here.

Current primitives:

| Function | Primitive | File |
|---|---|---|
| Leaf preimage → leaf hash | SHA-256 | `lib/witness/canonicalLeafV24.ts:101` |
| Chain hash | SHA-256(prev\|\|leaf) | `canonicalLeafV24.ts:110-120` |
| Merkle interior | SHA-256 RFC 6962 tagged | `lib/witness/merkle.ts:22-33` |
| Checkpoint signature | Ed25519 | `lib/witness/checkpointSign.ts:24, 62-66` |
| Ingest request auth | HMAC-SHA-256 | `lib/witness/hmacMiddleware.ts:43` |
| Tenant bearer verification | SHA-256 hash compare | `lib/witness/tenantAuth.ts:34-35, 48-58` |
| Legacy mint countersig | HMAC-SHA-256 | `/opt/scruple-witness/server.js:195-200` |
| C2PA JUMBF signature | ECDSA-P256 (ES256) | `services/c2pa-signer/vault_sign.py:37, 56, 83` |
| OCI Vault Sign algorithm | ECDSA_SHA_256 | `vault_sign.py:83` |
| Baseline signing key | Customer-side; SPKI hash committed | `packages/scruple-sdk-python/scruple/baseline.py:159-215` |
| Attestation envelope crypto | Vendor-defined | `packages/scruple-attestation-verifiers/src/plugins/*` |

No ML-DSA, ML-KEM, SLH-DSA, or SHA-3 anywhere. UNVERIFIED that specific dependencies (`jose`, `better-sqlite3`, `cryptography`, OCI SDK) already carry PQ primitives.

**Distance to CNSA 2.0 / FIPS 204 ML-DSA — all in-lane BUILD:**
- Trust manifest is algorithm-tagged (`witness-trust.json/route.ts:26-31`). Adding an `ML-DSA-44` key is a manifest-only change.
- Verifier already dispatches by `alg` (`cli.mjs:213-223`). Adding an ML-DSA branch is additive.
- Checkpoint signer is callback-shaped by design (`checkpointSign.ts:1-13`) — local key can be swapped for an OCI Vault callback or an ML-DSA-in-CVM callback with no refactor.
- SHA-256 for leaf/chain/Merkle stays quantum-safe for pre-image under Grover. SHA-384 or SHA3-256 is a v2.5 leaf-scheme bump if the operator wants extra margin.

Cross-repo: no PQ anywhere. Stooges/SJ HMAC-SHA-256 only; Ed25519 upgrade flagged as unbuilt (`ai-council/lib/sj/attestation.ts:22-25`). STIFS has no crypto of its own.

---

## PART B. Gap responses (GAP 1 through GAP 5)

Per WO Part 4: each gap draws contributions from any of core Scruple, Stooges, Stooges Junior, or STIFS. Cited, graded, lane-tagged.

### GAP 1. Non-person entities

**Vector:** partial fit; the identity substrate is in-lane and shipped. Channel-bound identity in the SPIFFE/mTLS sense is out of lane.
**Lane:**
- *In lane:* `principal_id`, delegations table, `workflow_hash` / `machine_manifest_hash` as leaf-first-class commitments to workload identity, baseline attestation for workload identity, SJ s2s HMAC substrate (record-schema + chain-discipline pattern for NPE credentials).
- *Adjacent:* nothing here.
- *Out of lane:* transport-layer channel-bound identity (SPIFFE / TLS-exporter / mTLS binding); Stooges application-layer `userContext` and character/service modeling; STIFS marketing-copy identity model. Only the *pattern* transfers.

Core Scruple (in lane):

- **`principal_id`** accepts arbitrary strings — no PII schema constraint (`030_scruple_log.sql:35-42`). `PRN_svc-mtc-a-track-processor` is a valid principal. SHIPPED.
- **`delegations`** (`030_scruple_log.sql:45-55`) — `delegations(delegation_id, principal_id, tenant_id, scope_streams, status, revoked_at)`. First-class table for "which agent may emit on behalf of which identity." `principalForUser.ts:64-69` refuses to auto-reactivate revoked delegations. SHIPPED.
- **`workflow_hash` + `machine_manifest_hash` first-class** (`canonicalLeafV24.ts:48-58`). Leaf carries cryptographic commitment to *which pinned pack of code* produced the event. For a Navy NPE, `workflow_hash` maps to "which service-binary manifest"; `machine_manifest_hash` maps to "which underlying platform pinning". SHIPPED as-analog, BUILD to relabel semantics.
- **Baseline attestation for workload identity** (`scruple-baseline.yaml`, `baseline.py`). Every fielded service submits a baseline that hashes code + deps + service_units + config + attestation envelope; `signer_pubkey_spki_sha256_hex` required per baseline (`baseline.py:159-172`) — functional service-cert-hash. SHIPPED.
- **Attested-client boundaries enumerated** (`SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md:39-61`): server-side capture, attested-client, TEE worker (SEV-SNP, TDX, Nitro, Confidential Space). Taxonomy SHIPPED.

Cross-repo in-lane (pattern transfers cleanly to Scruple witness-side):

- **SJ s2s HMAC substrate** (`ai-council/lib/sj/attestation.ts:1-207`). Two primitives on one HMAC-SHA-256 root:
  1. JWT-shaped attestation token (`signAttestation` / `verifyAttestation`): `{iss, aud, purpose, ..., iat, exp, jti}`, constant-time verify, 10 min bound, jti dedup, receiver stores `sha256(token)` as evidentiary receipt. Purpose-scoped. Navy fields become `service_id / device_id / attestation_ref / capability / gate_window / jti / iat / exp`.
  2. Per-request S2S signature (`signServerToServer` / `verifyServerToServer`): HMAC over `method\npath\nts\nsha256(body)`; 300 s clock skew. Working attested-process-principal calling a peer service per request.
  In-lane pattern; SJ code lives in application but reimplements cleanly at Scruple witness layer. SHIPPED (in SJ), BUILD (as Scruple primitive).

Cross-repo out-of-lane (pattern only):

- **Stooges `userContext`** (`ai-council/lib/auth/userContext.ts:1-100`) — per-request `AsyncLocalStorage` bind of caller `userId` propagated to every downstream library call. Out of lane (application context propagation), pattern in-lane in spirit: "identity terminates at the gate and flows to enforcement."
- **Stooges character/stooge abstraction** (`ai-council/lib/characters.ts`, `lib/reviewer/watcher.ts`, `lib/permissions/ServiceGate.ts:33-48`) — NPE-as-principal modelling. Out of lane; pattern-only.
- **STIFS** (`stifs-web/content/04-panel.md:150-156`, `content/07-integrations.md:118-127`) — split API-keys-for-service / OIDC-for-user model in copy. Out of lane; concept only.

**Out of lane, do not propose Scruple as delivering:**
- Channel-bound identity in the SPIFFE / TLS-exporter / mTLS sense. Scruple binds signatures to bodies, not to channels. Service-mesh subsystem is the right owner. Scruple can *log* which channel-id a call carried; it cannot *be* the channel-identity substrate.

### GAP 2. Mission-prioritized failure / break-glass

**Vector:** the recording discipline exists across repos and is in-lane. The mission-authority-elevated fail-open *decision* is fabric-side and out of lane. SJ's default is explicitly fail-closed; no in-tree exemplar of elevated fail-open exists in code.
**Lane:**
- *In lane:* `escalated` flag on the leaf, `escalation_policy` per stream, `_scruple.escalations` reserved stream, retraction-as-new-leaf rule (P5), `preserve_in_place` action, Stooges `escalation_log` (deviation-event schema template), SJ `notification_log` (evidentiary-capture-before-dispatch).
- *Adjacent:* Stooges `conductor_overrides` + `ServiceGate` three-verdict vocabulary — the *record shape* is in-lane pattern; the *decision runtime* stays in the policy engine (fabric or partner).
- *Out of lane:* SJ `juniorGate` fail-closed runtime, SJ rubric-dao override runtime, hardware-attested emergency-mode gate.

Core Scruple (in lane):

- **`escalated` column** (`030_scruple_log.sql:94`) — per-leaf boolean for "this leaf triggered elevated preservation." SHIPPED as column; setter BUILD.
- **`escalation_policy` per stream** (`030_scruple_log.sql:70`; `SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md:316-345`) — JSONB policy documented. Rule 1 at `SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md:311`: *"Escalation can only add. Any trigger may raise resolution; no component may suppress, redact, or drop a leaf. Monotonicity is what keeps an LLM in the loop safe."* Monotonicity discipline IS the "degraded-but-nonzero access, exhaustively ledgered" property. CONCEPT, in lane.
- **`_scruple.escalations` reserved stream** — audit-of-the-auditor. CONCEPT. Reserved-namespace mechanism exists (`ingest.ts:29`, `RESERVED_STREAM_PREFIX = /^(?:_scruple\.|scruple\.)/`); specific stream not seeded. In lane.
- **Retraction-as-new-leaf (P5)** (`SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md:118-124`): *"Retractions MUST be modeled as new witness events, not as deletions ... The incorrect leaf remains in the audit chain."* SHIPPED as normative rule. In lane.
- **`preserve_in_place`** — full-resolution bundle to customer WORM, Docent holds commitment leaf (`SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md:338`). CONCEPT, in lane.
- No signed `EmergencyDeviation` leaf type exists. Break-glass today encodes as `meta.action = "break-glass"` + `escalated = 1`. Works; nothing enforces the convention. Open question 4 seeds a reserved stream.

Cross-repo in-lane (record-schema template transfers verbatim):

- **Stooges `escalation_log`** (`ai-council/lib/db/migrations/011_escalation_log.sql:4-18`) — tombstone row per escalation event: `session_id`, `stooge_id`, `provider`, `reason`, `confidence`, `context_pkg` (2 KB JSON packet), `status ∈ {escalated, returned, interrupted}`. Written on escalation start, resolved on clean cycle-back, detectable on resume. Replace reason enum with `{mission_priority, connectivity_loss, operator_override}` and the row survives verbatim. SHIPPED (Stooges), in-lane template for Scruple.
- **SJ `notification_log`** (`ai-council/lib/db/migrations/096_sj_parent_linkage.sql:70-107`) — append-only, body captured *before* the transport call. Break-glass-triggered notification survives even if delivery fails. SHIPPED. In-lane pattern.

Cross-repo adjacent (partial-transfer):

- **Stooges `conductor_overrides`** (`ai-council/lib/db/migrations/016_conductor_overrides.sql:4-15`) — override queue with `decision`, `rationale` (audit-visible), `redirect_prompt`, `consumed` flag. Adjacent: the *queue record schema* (what's requested + rationale + resolution status) is in-lane pattern; the *dispatch runtime* stays out of lane. SHIPPED.
- **Stooges `ServiceGate`** (`ai-council/lib/permissions/ServiceGate.ts:20-159`) — three-verdict gate (`allow | deny | escalate`). Adjacent: the *vocabulary* is in-lane (Scruple records these verdicts); the *gate implementation* stays in the policy engine (fabric side for Navy). SHIPPED.

Cross-repo out-of-lane (pattern-only lesson):

- **SJ `juniorGate` fail-closed runtime** (`ai-council/lib/conductor/juniorGate.ts:1-140`, line ~139: *"on a Director error we BLOCK — a kids' safety gate should fail closed, not open"*). Correct for a kids' app; *opposite* of what a mission-priority combat surface wants. The honest lesson: we know how to build fail-closed cleanly; we have no in-tree exemplar of the elevated fail-open path.
- **SJ `rubric-dao.ts` override-only-if-stricter** (`ai-council/lib/sj/rubric-dao.ts:242-248`) — parent-override rule enforces *"only accept override if stricter."* Inverse of break-glass; the *machinery* (compare candidate vs. override at ordering level, reject if weaker) informs "break-glass may not exceed authorized envelope" checks. Pattern-only.

**Out of lane, do not propose Scruple as delivering:**
- Hardware-attested emergency mode / the mission-authority fail-open *decision*. That is fabric RTL work + policy engine mediation. Scruple records the deviation event exhaustively (in lane); it does not *decide* to fail open. Partner contract: fabric decides + attests the emergency invocation; Scruple ledgers the decision with elevated evidentiary weight.

STIFS: nothing to offer.

### GAP 3. Enclave scale-out

**Vector:** minimal in Scruple today; the SJ ↔ Stooges HMAC channel is the only production cross-node primitive in tree; N-node scale-out is new work, but all of it is in lane.
**Lane:**
- *In lane:* per-node witness, cross-anchor discipline, peer-to-peer replication (BUILD), quorum witness signing (BUILD), split-brain reconciliation (BUILD), assurance-tier menu, signed-CRL/trust-manifest distribution channel.
- *Adjacent:* nothing.
- *Out of lane:* the network transport layer itself.

Core Scruple (in lane):

- Single-node witness is explicit; multi-tenant at the witness is SHIPPED (aggregation, not scale-out).
- **Assurance-tier menu** (`CANONICAL_SCRUPLE_WITNESSING_L2.md:369-384`) — `standard / enhanced / qualified` with `checkpoint_secs`, `tsa_mode`, `anchor_epoch_secs` knobs. CONCEPT, in lane.
- **Cross-anchor pattern that transfers.** Each enclave node runs a witness; nodes cross-anchor via the same super-root mechanism used to anchor externally today. Substitute peer-node "here is my super-root, please sign that you saw it" for external-ledger post. COALESCE + retries-monotonically-complete (`server.js:258-262`) handles intermittent connectivity by design. CONCEPT-with-strong-precedent, in lane.
- **Absent (BUILD in lane):** peer-to-peer leaf replication, quorum witness signing, split-brain reconciliation on rejoin, cross-node super-root anchoring, signed-CRL distribution channel.

Cross-repo in-lane pattern:

- **SJ ↔ Stooges HMAC channel** (cited under R-C). Two-enclave production pattern with cryptographic per-request binding, independent DBs, local policy-consistency check on receipt. Not N-node, not gossip, not consensus — but the two-node primitive is real and running. SHIPPED (in SJ), in-lane pattern for Scruple witness-to-witness.

STIFS: `content/08-trust.md:56-66` three deployment modes with "anchored locally (with optional public-chain bridge)" in edge mode. CONCEPT-only.

### GAP 4. Administrative overhead reduction

**Vector:** concrete, quantifiable automation exists in Scruple and Stooges. Honest cap: no measured human-baseline timings on file — M&S should count *automated steps replacing manual steps*, not seconds saved, unless Navy supplies the timing baseline.
**Lane:**
- *In lane:* `audit-receipts.py`, `ci-baseline-drift-check.mjs`, `scruple-verify` CLI, cross-DB correlation, C2PA evidence-bundle auto-generation (packaging in-lane; the C2PA standards constraint is adjacent), server-side attestation re-verify.
- *Adjacent:* nothing in the Scruple items.
- *Out of lane:* Stooges auditor.ts, bundle.ts, admin_audit_log; SJ summarizeJuniorLog, notify.ts, rubric-dao — application-layer code. Only the *patterns* (auto-summary over structured event log, before/after JSON snapshots, capture-before-dispatch) transfer as in-lane design principles.

Core Scruple in-lane countable automation:

- **`scripts/audit-receipts.py`** (386 lines) — 12 project modes × ~24 checks = ~288 automated checks in under 60 seconds. Each was previously manual grep/inspect/re-hash. Automation ratio ~288:1. SHIPPED.
- **`scripts/ci-baseline-drift-check.mjs`** (`ci-baseline-drift-check.mjs:38-142`) — every PR gets automated tamper-surface drift check. Blocks merge without `[baseline-decision: rebaseline|expand-manifest|false-positive]` tag. SHIPPED.
- **`packages/scruple-verify` reference verifier CLI** — shore-side auditor verifies a chain in seconds where prior verification was manual grep + SQL + hand-hash. SHIPPED.
- **Cross-DB correlation** (`audit-receipts.py:156-172`) — joins web DB, witness DB, receipt HTML, journalctl automatically. SHIPPED.
- **C2PA evidence bundle auto-generation** — `docs/c2pa-conformance-evidence/2026-07-14/`, `docs/l2-evidence/2026-07-12T174954Z/` auto-generated by `services/c2pa-signer/build_evidence_bundle.py`. Signed certs, SEV-SNP measurements, VCEK proofs. SHIPPED. The *packaging* is in lane; the *C2PA output-standard target* is adjacent (external standards body).
- **`platform_attestation` server-side re-verification at ingest** (`lib/baseline/ingest_check.ts:127-241`) — eliminates "did the customer really run in a TEE?" audit question at write time. SHIPPED.

Cross-repo out-of-lane code (in-lane patterns):

- **Stooges `auditor.ts` silent conductors** (`ai-council/lib/conductor/auditor.ts`) — pattern: automated summary generation over structured event log. Application code out of lane; pattern in lane for Scruple verifier CLI.
- **Stooges `bundle.ts`** (`ai-council/lib/sharing/bundle.ts`) — pattern: portable versioned bundle. Application code out of lane; pattern in-lane for the Scruple `--offline` verifier bundle called out under R-D.
- **Stooges `admin_audit_log`** (`ai-council/lib/auth/audit.ts`) — pattern: before/after JSON snapshots on every mutation. In-lane pattern for a governance-event schema on `_scruple.provisioning`.
- **SJ `summarizeJuniorLog`** (`ai-council/app/api/junior/log/[childId]/route.ts`, `lib/conductor/juniorLog.ts:70-82`) — pattern: server-side summary over raw event log for third-party consumption. Application code out of lane; pattern in-lane for the shore-side verifier read-back.
- **SJ `notify.ts`** (`ai-council/lib/sj/notify.ts:44-70`) — pattern: capture-before-dispatch. Application code out of lane; pattern in-lane for `notification_log`-style evidentiary discipline in Scruple.
- **SJ `rubric-dao.ts`** — pattern: DB-driven versioned policy re-applied without redeploy. Application code out of lane; pattern in-lane for signed-policy-bundle distribution.

STIFS: `content/06-solutions.md:145-147` "batch deliberation overnight, humans review the small subset flagged" — marketing-copy shape, no metric, no baseline, no code. Out of lane.

### GAP 5. ICAM enrollment + revocation mechanics

**Vector:** partial primitives are shipped across repos; a unified signed CRL for disconnected distribution is BUILD in lane; the strongest single fit in tree is SJ's enrollment + revocation stack.
**Lane:**
- *In lane:* trust manifest, baseline history, delegation/api-key revocation, epoch-based validity, signed CRL for disconnected distribution (BUILD), SJ enrollment (schema + verifier), SJ revocation via `child_links.revoked_at`, SJ `rubric_versions` bundle discipline.
- *Adjacent:* Stooges `mobileTokens` rotation discipline — the *pattern* is in-lane; the *code* is application-layer session tokens.
- *Out of lane:* Stooges `accessCookie` web session, `beta_codes` redemption ledger, `AUTH_SECRET` rotation kill-switch, SJ deterministic-triggers runtime — application-layer code. Only *patterns* transfer.

Core Scruple in-lane:

- **Trust manifest as key-distribution channel** (`app/.well-known/witness-trust.json/route.ts`) — publishes `{key_id, alg, public_key_pem, activated_at, deprecated_at}`. Verifier consumes offline (`cli.mjs:96-113`) and honors `deprecated_at` (`cli.mjs:108-111`). SHIPPED but simple: single tenant, single point-in-time snapshot; no historical query, no signed content-addressed manifest, no CRL entries beyond `deprecated_at`.
- **Baseline history endpoint** (`app/api/v1/registry/baselines/[tenant]/history/route.ts`) — de-facto tenant identity/attestation revocation record. SHIPPED.
- **Delegation revocation** (`030_scruple_log.sql:45-55, 52`) — `delegations.status IN ('active','revoked')`, `revoked_at TEXT`. Ingest rejects with `delegation_inactive` (`ingest.ts:272-274`). No-auto-reactivate policy (`principalForUser.ts:63-69`). SHIPPED.
- **API key revocation** (`023_api_keys.sql:26,30`; `lib/auth/apiKey.ts:71-79`) — `revoked_at INTEGER` column, partial index. SHIPPED.
- **Ceremony/rotation runbooks** (`CANONICAL_SCRUPLE_WITNESSING_L2.md:125-136`, §4.3). CONCEPT.
- **Epoch-based validity primitives** — checkpoints carry `epoch_index` (`030_scruple_log.sql:105`), `anchor_epochs` (`030_scruple_log.sql:121-129`), per-stream `anchor_epoch_secs`. First-class temporal primitive. Attaching key-validity windows to epochs is BUILD in lane.
- **Signed CRL for disconnected distribution** — trust manifest currently served unsigned over HTTPS. No static content-addressable form, no manifest-scope signature, no cached-CRL-with-epoch pattern. BUILD in lane. Baseline-chain code (`baseline_verify.mjs`) is the closest transferable substrate.

Cross-repo in-lane (strongest fit in either tree):

- **SJ enrollment + revocation stack:**
  1. **Attested enrollment** — `signAttestation` (main) issues 10-min purpose-scoped jti-unique token; `verifyAttestation` (junior) constant-time verify + iss/aud/purpose/exp checks + returns `sha256(token)` as `attestation_token_hash` stored on `child_links` (`ai-council/app/api/junior/claim-child/route.ts:37-93`). SHIPPED.
  2. **Revocation** — `child_links.revoked_at` + `child_links.revoked_reason`; every downstream lookup filters `revoked_at IS NULL`; returns `410 Gone`. CRL-shaped mechanism against distributed record. SHIPPED.
  3. **Policy-bundle version + activation** — `rubric_versions` (`ai-council/lib/db/migrations/089:27-41`) with `status ∈ {draft, active, deprecated}` + unique index enforcing exactly one active version, `activated_at`, `deprecated_at`. Signed-policy-bundle-with-epoch mechanics minus the signature (HMAC over canonicalized row set completes the shape). SHIPPED.
  In-lane pattern; SHIPPED (in SJ), in-lane BUILD (as Scruple witness primitive).

Cross-repo out-of-lane (pattern-only):

- **SJ `deterministic-triggers.mjs:1-80`** — pre-filter cache runs BEFORE the LLM classifier so local decisions continue against a cached rubric bundle even if the Director model call fails. Runtime out of lane (SJ policy engine); pattern in-lane: cached signed bundle that keeps enforcing across disconnect maps directly to a Navy edge node continuing to enforce against a cached signed CRL.
- **Stooges `mobileTokens`** (`ai-council/lib/auth/mobileTokens.ts:1-202`) — enrollment + rotation + revocation. `rotateRefresh` mints new pair and revokes old atomically; `shouldRotate` true when within 24 h of expiry (proactive). `revokeAllForUser` + partial-index `WHERE revoked_at IS NULL`. Adjacent: rotation discipline is in-lane pattern; code is application-layer session tokens. SHIPPED (in Stooges), in-lane pattern for Scruple.
- **Stooges `accessCookie`** (`ai-council/lib/auth/accessCookie.ts:1-143`) — HMAC-signed capability with `{iat, exp, codeRef}` payload, one-week epoch, Web-Crypto so same code runs in Edge and Node. Middleware enforces signature without DB round-trip. Out of lane (web session); pattern in-lane: edge-resident signed-capability enforcement — directly informs a Navy edge node consuming a signed CRL.
- **Stooges `beta_codes`** (`ai-council/lib/auth/beta-codes-dao.ts:35-132`) — atomic redemption ledger. Out of lane (application beta system); pattern only.
- **`AUTH_SECRET` rotation** (`ai-council/lib/id/synthetic.ts:15-17`) — kill switch for every synthetic principal. Out of lane; too blunt for Navy anyway.

STIFS: copy-only. `stifs-web/content/07-integrations.md:118-127` names SAML/OIDC/mTLS/API-keys as identity primitives; "RBAC mappings defined in configuration." No revocation, no epoch, no distribution mechanism in code. Effectively ABSENT.

---

## PART C. Stooges / Stooges Junior / STIFS — Part 4 definitions

Ground-truth one-liners + maturity grades based on the current repositories. External understanding elsewhere is stale.

- **Stooges** — multi-model deliberation platform (theatrical *Productions → Scenes → Takes → Stooges* hierarchy) that fans a prompt out to Claude / Grok / Gemini / GPT under a conductor-mediated cross-feedback loop, with account tiers, Google/OneDrive/GitHub-backed storage, provenance-auditor logging, and a cross-domain HMAC attestation channel to the Stooges Junior enclave. **Grade: SHIPPED, production.** Public on `app.stooges.ai`; 84 SQLite migrations; Next.js middleware-enforced edge gates. Root `README.md` calling it "a scaffold, not a production app" is out of date; `lib/`, `app/api/`, migrations, and `middleware.ts` are ground truth.
- **Stooges Junior** — kid-safe fork of Stooges that inserts a fail-closed Director gate on every prompt (input) and every stooge response (output) driven by a versioned age-banded content-safety rubric, with append-only categorical verdict logging (`rubric_verdicts`), a deterministic keyword pre-filter (`deterministic-triggers.mjs`) BEFORE the LLM classifier, and a cross-enclave HMAC-attested audit stream that surfaces to the parent dashboard on the Stooges platform. **Grade: SHIPPED, partial-production.** 85 SQLite migrations (superset of Stooges); working `junior.stooges.ai` peer; production copy at `/data/stooges-junior-prod`. Ed25519 upgrade to s2s channel documented but unbuilt.
- **STIFS** ("Safety-Tethered Inferential Fabric System") — Next.js 15 marketing website (`app/`, `content/*.md`) for a B2B product concept: multi-model Inference Fabric ("Core"), safety-tethered Policy Conductor, Scruple-powered Witness ledger — sold via three integration surfaces (REST / A2A peer / MCP server) with three deployment modes (Managed Cloud / Customer VPC / Edge). **Grade: CONCEPT, marketing-only.** Repo has no product code: 10 markdown files under `content/`, thin route wrappers, four presentation components, 15-line markdown loader (`lib/content.ts:6-14`); no `prisma/`, no `app/api/`, no auth code, no ledger code. Every mechanism in copy is "filed" or sourced from Scruple.

---

## PART D. Honest summary — for this design

**What Scruple can deliver end-to-end (in lane).** Ledger discipline in every dimension the WO asks for: subject-agnostic canonical leaf schema, per-stream monotonic sequence with gap detection, chained checkpoint hashes, balanced-Merkle checkpoint scheduler, Ed25519 checkpoint signature under a callback-shaped signer seam, partial-anchor-set semantics, per-tenant HMAC ingest auth, delegations with revocation, baseline chain walkable back to genesis, platform-attestation envelope registry with vendor-plugin dispatch, server-side re-verification at ingest, offline reference verifier CLI with algorithm-tagged trust manifest, quantifiable audit-automation surface (~288 checks/60 s + CI drift gate + auto-bundled evidence). New work still in lane and BUILD-viable via existing seams: a v2.5 leaf with promoted `device_id / verdict / assurance_level / gate_window_id`; a hybrid Ed25519 + ML-DSA checkpoint key; reserved streams (`_scruple.provisioning`, `_scruple.escalations`, `_scruple.revocations`); a signed trust-manifest history + `--offline` verifier bundle + consistency-proof endpoint; peer-to-peer leaf replication and quorum witness signing on the anchor-to-N-authorities pattern; unified signed CRL riding the trust-manifest channel. **All of this is Scruple SBIR scope.** Also in-lane and transferable from Stooges/SJ: the SJ `x-sj-s2s-sig` HMAC substrate (per-request NPE credentials), SJ `rubric_verdicts` (schema template), SJ `child_links` (provisioning-receipt schema), SJ enrollment+revocation+policy-bundle-version stack, and Stooges `escalation_log` (deviation-event schema template).

**What Scruple delivers at an integration surface (adjacent — partner subsystem shares the contract).** FPGA attestation quote generation: Scruple ships the envelope plugin and the re-verifier; the FPGA vendor ships the quote generator and the evidence bytes. C2PA-compliant signer path: Scruple's crypto agility is unbounded, but C2PA (the external standard) currently constrains ES256; whether Navy targets C2PA compliance at all is a scoping decision (open question 3). Policy vocabulary (allow/deny/escalate/override): Scruple records the verdicts; the policy engine — fabric-side for Navy — produces them.

**What Scruple cannot deliver (out of lane; different subsystem, different vendor, different bid line).** Transport-layer channel-bound identity (SPIFFE / TLS-exporter / mTLS): Scruple binds signatures to *bodies*, not to *channels*. That is service-mesh territory. Scruple can *log* which channel-id carried a call; it cannot *be* the channel-identity substrate. The hardware fail-open decision itself: Scruple ledgers the deviation event exhaustively (in-lane), but the *decision* to open under mission authority is fabric RTL work mediated by the authentication engine — Scruple witnesses it, does not perform it. The RTL implementation of the ledger: the WO explicitly divides this at Part 1 plane 4 — fabric writes the chain in RTL; Scruple defines the schema, chain discipline, verifier tooling, and anchoring/replication protocol. RTL is a fabric team deliverable.

The proposal shape that follows: everything in the first paragraph is proposed as Scruple SBIR scope. Everything in the second paragraph is proposed as *Scruple integrating with partner X* — Scruple contract is schema + witness + verify; partner contract is quote/decision/standard-body compliance. Everything in the third paragraph goes on a different line of the bid (or is scoped to a different vendor entirely).

---

## PART E. Open questions for the operator (flagged, not resolved)

1. **Access-event `resource` encoding.** Per-resource stream (loses cardinality; simplifies indexing) vs. `payload_hash = sha256(canonical_resource_ref)` (loses queryability; keeps schema) vs. new v2.5 first-class `resource_id` field (needs leaf-scheme bump; cleanest). All three in lane.
2. **Device identity granularity.** One tenant per device (SHIPPED, tenant-count explodes at Navy scale) vs. one principal per device (SHIPPED, PII-shape concerns) vs. new v2.5 `device_id` leaf field (BUILD, cleanest). Same schema-bump machinery as (1). All in lane.
3. **C2PA-compliant signer path — needed at all in this design?** If not, ES256 constraint disappears and PQ-only ML-DSA becomes viable in the same signer without hybrid. This decision moves the C2PA compliance question from adjacent to N/A.
4. **Reserved-stream instantiation.** `_scruple.provisioning` (R-B), `_scruple.escalations` (GAP 2), `_scruple.revocations` (GAP 5) — naming convention exists (`ingest.ts:29`); instantiation and per-stream escalation policies are the decision. In lane.
5. **Peer-to-peer replication protocol shape.** Gossip vs. pull-from-adjacent vs. signed-heartbeat vs. anchor-to-adjacent-peer-super-root (direct reuse of the external-ledger pattern). New work, in lane, no primitive in tree for the transport shape itself.
6. **Whether the SJ `x-sj-s2s-sig` HMAC substrate is the shortest path to a Navy per-request NPE credential before layering PQ.** It is in production, byte-simple, and already carries `{principal, purpose, iat, exp, jti}` + integrity binding to payload. Lifting to Ed25519 (already in `checkpointSign.ts`) then to ML-DSA follows the same manifest-alg / verifier-dispatch seam. All in lane.
7. **Whether Stooges `escalation_log` schema should be lifted verbatim as the Navy deviation-event template.** Field-rename + reason-enum swap is the entire lift. In lane.
8. **Whether `principal_mode='per_leaf'` (existing knob) with signed delegation is a sufficient substrate for the mission-authority elevated fail-open path**, or whether elevated fail-open needs its own leaf type / reserved stream / signer key with distinct trust-manifest entry. Note: this is the *record* side. The *decision* side stays out of lane (fabric).
9. **Assurance-tier presets to lock for Phase I M&S.** `standard / enhanced / qualified` documented at `CANONICAL_SCRUPLE_WITNESSING_L2.md:369-384`. In lane.
10. **Trust-manifest signing.** Current manifest is served unsigned over HTTPS; disconnected-node CRL distribution requires the manifest itself be signed with epoch validity. Existing baseline-chain code is the closest transferable substrate; discrete signing-of-the-manifest is BUILD in lane.
11. **Where does the SPIFFE / mTLS / service-mesh identity layer come from in the Navy design?** Not Scruple — out of lane. Either the fabric-side authentication engine subsumes it (with Scruple recording the channel-id it saw) or a service-mesh subsystem is proposed as a separate bid line. Operator decides which shape fits the Q&A envelope; Scruple contract is unchanged either way.
12. **Which partner owns the FPGA attestation quote generator and its evidence-byte format?** Scruple can absorb any well-defined envelope as a verifier plugin. The vendor of the quote generator (and the format they emit) is an adjacent decision that sets the shape of the plugin.
