# Scruple Witnessing & C2PA L2 — Canonical Design

**Status:** APPROVED design, in execution
**Doc version:** 1.0 (2026-07-12)
**Owner:** Scruple / Docent
**Read time:** ~25 min. This is the source of truth for the L2 build and the
Independent AI Witnessing Rider product. If it disagrees with any other doc,
this doc wins until it is superseded here.

**Depends on / supersedes:**
- `docs/architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md` (rolled in here + still
  authoritative for the leaf/canonicalization schema details in §5.1 of that doc)
- `docs/architecture/Independent_AI_Witnessing_Rider_TEMPLATE.md` (the customer-
  facing legal instrument this system contractually satisfies)
- `docs/c2pa-interop/2026-07-12-interop-test-report.md` (L1 interop evidence; L2
  supplements this, does not replace it)
- The C2PA L1/L2 evidence report + OCI migration plan from session 2026-07-12

---

## 1. Purpose

Stand up **one system** that simultaneously:

1. Meets the **C2PA Conformance Program L2** implementation-security bar for
   Scruple's manifest signer (Soft Scruple / server-side signing path).
2. Delivers the **Continuous Audit API** ("Scruple Log" / "the tunnel") that any
   third-party vendor can wire an event stream into and get witnessed evidence.
3. Contractually satisfies the **Independent AI Witnessing Rider** template so
   customer counsel can attach that rider to their MSA/DPA and the terms are
   self-executing against this production stack.

The three deliverables share one signing-key architecture, one leaf/checkpoint/
anchor pipeline, and one reference verifier CLI. Building them as separate
subsystems would triple the work and split the L2 evidence.

## 2. Scope

**In scope (this document):**
- OCI Vault key custody for two signing keys (C2PA end-entity + witness checkpoint).
- Signer process isolation and access control.
- Continuous Audit API: tenants, principals, delegations, streams, leaves,
  checkpoints, anchor epochs.
- C2PA signing becomes a **tenant + stream** inside the audit API — the existing
  `POST /api/scruple/c2pa/sign` route emits its sign events to a
  `scruple.c2pa.sign` stream instead of an ad-hoc log.
- Reference verifier CLI (`scruple-verify`).
- Assurance-tier menu (standard / enhanced / qualified) implementing RFC 3161
  and eIDAS-qualified TSA integration.
- Rider clause mapping (§10 below).

**Out of scope (this document):**
- Hard Scruple (FPGA / TME hardware root of trust) — CONFIDENTIAL, separate track.
- Escalation Layer (Jailbird triage + LLM verdicts) — flagged, Phase 2, stubbed here.
- Non-Scruple tenants beyond the reference SDK — sales-phase; the ingest API is
  built to be multi-tenant from day one, but onboarding UX beyond the demo tenant
  is Sprint 3+.

## 3. Trust Model

### 3.1 Three-party geometry

| Role | Held by | Holds | Never holds |
|---|---|---|---|
| **Principal** | End enterprise / individual with the Article 50 obligation and verification right | Direct-issued read/verify credential; can pull proofs without vendor cooperation | Any mutation right over the log |
| **Tenant** | Vendor operating the AI stack (Scruple itself is Tenant #0; third-party vendors are Tenants #1+) under revocable delegation | API key + HMAC secret; emit-only authority against principals that have delegated | Vendor cannot alter, backdate, or hide historical leaves; cannot access another principal's read side |
| **Witness** | Docent Technologies, operating the Scruple witness cluster | Hash leaves, chains, checkpoints, anchors, both signing keys | Any content — payloads, prompts, PII. Zero-content posture is enforced at the ingest schema |

### 3.2 The independence invariant

> The party being audited never operates the log; the log operator never holds
> the data.

Concretely: when a principal exercises GDPR erasure and deletes their raw
payload from their WORM store, the leaf that hashed it remains on our chain but
now hashes bytes that no longer exist anywhere — an orphaned commitment,
not a record of a person. This gives us erasure-compatible immutability, which
is the load-bearing legal posture the Rider relies on.

### 3.3 Delegation

- Every principal has a `principal_id` (`PRN_` + 8 hex) and a read-key hash on
  file at the witness.
- A `delegations` row authorizes a tenant to emit for a principal on named
  streams (or all streams).
- Delegation grant + revocation events are themselves written as leaves on
  reserved stream `_scruple.delegations`. Governance is witnessed like everything
  else.
- Revocation → tenant loses emit authority for that principal AND a proof-bundle
  export is auto-generated for the principal, no fee.

### 3.4 Scruple itself as a tenant

Scruple's C2PA signer is Tenant #0, emitting to stream `scruple.c2pa.sign`
under delegation from each Scruple end-user Principal. This is the important
architectural choice: **the same code path that satisfies the enterprise
Rider product also satisfies the C2PA L2 audit-log requirement.** There is no
"internal" version of the pipeline.

## 4. Key Custody (OCI Vault)

### 4.1 Two keys, one Vault

| Key | Purpose | Algorithm | Cert / trust |
|---|---|---|---|
| `scruple-c2pa-signer-prod` | Sign C2PA JUMBF claims | ECDSA_NIST_P256 (ES256) | Production end-entity cert issued by DigiCert Content Credentials or SSL.com C2PA; chain terminates at a C2PA-trust-list root |
| `scruple-witness-checkpoint-prod` | Sign per-stream interval checkpoints (Ed25519 preferred; ECDSA_NIST_P256 fallback if Vault does not support Ed25519 asymmetric at production tier) | Ed25519 or ECDSA_NIST_P256 | Rooted at a Scruple witness CA also held in OCI Vault; witness public key published in a signed trust manifest at `https://scruple.stooges.ai/.well-known/witness-trust.json` |

Both keys live in OCI Vault in **Virtual Private** protection mode
(HSM-backed, non-exportable, FIPS 140-2 Level 3). Neither key material ever
enters any Scruple process's address space.

### 4.2 IAM / access

- Dedicated Dynamic Group `scruple-signer` matched by compute instance principal
  in a dedicated compartment.
- IAM policy grants `Sign` and `GetPublicKey` on both keys — nothing else. No
  `Delete`, `Backup`, `Export`, `Restore`, `Rotate` for the compute instance.
- Separate `scruple-key-admin` group (humans, MFA-gated, break-glass logged)
  holds rotation + admin rights.
- OCI Audit captures every `Sign` call automatically. Retention: 365 days rolling
  window at Vault, permanently archived to Object Storage bucket
  `scruple-vault-audit-archive` (compliance mode object lock, 7-year retention).

### 4.3 Rotation policy

- **Annual** rotation of both keys, scheduled ceremony documented in
  `docs/architecture/lifecycle/key-rotation-runbook.md` (produced under
  Sprint 3, WO-17).
- On rotation, a new Vault key OCID is issued, a fresh CSR is generated and
  submitted to the issuer (C2PA) or self-signed (witness CA), the new public key
  is added to the trust manifest, and old key remains valid for a 30-day grace
  window for existing-signature verification.
- Emergency rotation runbook covers suspected compromise: disable IAM `Sign`,
  publish CRL entry, notify affected principals, re-anchor a "rotation event"
  leaf.

## 5. C2PA Signing Path (Post-L2)

### 5.1 The refactor in one call

`services/c2pa-signer/sign.py` today:

```python
signer = c2pa.Signer.from_info(c2pa.C2paSignerInfo(
    alg=c2pa.C2paSigningAlg.ES256,
    sign_cert=cert_bytes,
    private_key=key_bytes,        # ← raw key in process memory. L1.
    ta_url="http://timestamp.digicert.com",
))
```

Becomes:

```python
signer = c2pa.Signer.from_callback(
    callback=vault_sign_es256,     # ← OCI Vault Sign() API. No raw key.
    alg=c2pa.C2paSigningAlg.ES256,
    certs=cert_chain_pem,          # ← production cert chain
    ta_url=os.environ["SCRUPLE_C2PA_TA_URL"],
)
```

Where `vault_sign_es256(data: bytes) -> bytes` calls
`KmsCryptoClient.sign(sign_data_details=SignDataDetails(
key_id=<c2pa-signer-ocid>, message=<b64(data)>, message_type='RAW',
signing_algorithm='ECDSA_SHA_256'))`, receives base64 DER-encoded ECDSA, decodes
to R+S via `decode_dss_signature`, and returns raw 64-byte `R||S` per RFC 8152.

### 5.2 Removed at the same time

- `c2pa.load_settings('{"verify":{"verify_after_sign":false,"verify_trust":false}}')`
  is gated behind `SCRUPLE_C2PA_DEV=1`, which the prod systemd unit is
  incapable of setting (`Environment=SCRUPLE_C2PA_DEV=` explicitly cleared).
- The `services/c2pa-signer/keys/es256.pem` sample private key file is deleted
  from the tree, and a pre-commit hook rejects any PEM blob under
  `services/c2pa-signer/keys/`.
- File-based cert loading is retained (`SCRUPLE_C2PA_CERT_CHAIN` env → PEM file
  path) — only the private key path is removed.

### 5.3 Isolation

The C2PA signer runs as a **separate systemd unit** `scruple-c2pa-signer.service`
under a dedicated OS user `scruple-signer`:

```ini
[Service]
User=scruple-signer
Group=scruple-signer
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadOnlyPaths=/etc/scruple/c2pa-cert.pem
InaccessiblePaths=/data/scruple-web/services/c2pa-signer/keys
ExecStart=/usr/bin/python3 /opt/scruple-signer/sign_daemon.py --socket /run/scruple-signer.sock
```

Next.js talks to it over `/run/scruple-signer.sock` (Unix domain socket, 0660,
owned by `scruple-signer:www-data`). The Node.js user cannot read the OCI
credentials that authenticate to Vault; only `scruple-signer` can.

Egress-side: OCI VCN security list allows the `scruple-signer` compute instance
egress ONLY to `vault.<region>.oci.oraclecloud.com` and the TSA endpoints in
`TSA_ALLOWED_URLS`. No general internet.

### 5.4 Sign event → leaf emission

On every successful (or failed) sign:

1. Signer daemon writes a canonical leaf preimage:

   ```
   canonicalLeafV23({
     tenant_id: "TEN_scruple",
     principal_id: <caller principal_id>,
     stream_id: "STR_c2pa_sign",
     tenant_seq: <atomic monotonic counter for this stream>,
     event_time: <UTC RFC3339>,
     payload_hash: "sha256:<hash of {asset_sha256, output_manifest_sha256,
                            cert_serial, kms_key_ocid, product, tier}>",
     dims: {},
     meta: {product, tier, region}   // NON-SENSITIVE only
   })
   ```

2. POSTs to `/v1/log/scruple.c2pa.sign` on the local witness process (Unix
   socket, no network hop).

3. Receives `{leaf_hash, chain_hash, pending_checkpoint_epoch}` — records the
   correlation into the C2PA API response so downstream systems can pull the
   inclusion proof.

Zero content leaves Scruple in the leaf. The signed asset stays where it was;
the leaf carries hashes only.

## 6. Continuous Audit API

Full schema and endpoint surface is in
`docs/architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md`. The details below are
the delta / clarifications on top of that doc that were decided in the
2026-07-12 planning session.

### 6.1 Data model (final)

Tables introduced under migration `022_scruple_log.sql`:

- `tenants` — API key hash + HMAC secret + status. Scruple gets seeded as
  `TEN_scruple` with a special "internal" flag.
- `principals` — read-key hash + display name.
- `delegations` — principal ↔ tenant + scope + status + timestamps. Unique
  `(principal_id, tenant_id)`.
- `streams` — per-tenant named streams with checkpoint_secs, tsa_mode,
  anchor_epoch_secs, retention_days, principal_mode, escalation_policy.
- `log_leaves` — the actual leaves. Primary key `(stream_id, tenant_seq)` +
  unique `(stream_id, idempotency_key)`.
- `checkpoints` — per-stream interval Merkle roots + Ed25519 sig + optional
  TSA token + `prev_checkpoint` for consistency chain.
- `anchor_epochs` — super-root + RVN txid + IPFS CID + Arweave id (COALESCE
  semantics, existing pipeline).

Migration is SQLite for parity with the existing Scruple DB; Postgres is the
target for scale but is out of scope for Sprint 1–3. Design ports one-to-one.

### 6.2 Ingestion API surface

Base path `/v1/log`. Auth = `Authorization: Bearer <api_key>` **plus**
`X-Scruple-Signature` (HMAC-SHA256 over `<timestamp> || <body>` using the
tenant's `hmac_secret`; clock skew tolerance 5 min).

Endpoints (Sprint 1 subset marked ✱):

- ✱ `POST /v1/log/{stream_name}` — single leaf ingest
- ✱ `POST /v1/log/{stream_name}/batch` — up to 1000 leaves
- ✱ `POST /v1/streams` — create/update stream
- ✱ `GET  /v1/streams` — list tenant streams + current state
-   `POST /v1/tenants` (admin) — provision tenant
-   `POST /v1/principals` (tenant, with delegation) — invite principal
-   `POST /v1/delegations` — grant/revoke
- ✱ `GET  /v1/proof/leaf/{stream_id}/{tenant_seq}` — inclusion proof bundle
-   `GET  /v1/proof/consistency/{stream_id}/{epoch_a}/{epoch_b}` — consistency
-   `GET  /v1/principal/leaves` (principal auth) — own leaves across tenants
-   `POST /v1/principal/export` (principal auth) — async proof-bundle export

### 6.3 Canonical leaf v23

Exactly as in the Continuous Audit design doc §5.1. Fixed field order, compact
JSON, empty-string defaults. Cross-side hash parity between the SDK helper and
the server recomputation is a **unit-test gated invariant** (WO-05).

### 6.4 Checkpoint service (Tier 1)

Per-stream scheduler (BullMQ) firing every `checkpoint_secs`:

1. Select `leaves WHERE stream_id = ? AND tenant_seq > last_checkpoint.last_seq`.
2. If empty → **heartbeat checkpoint**: `merkle_root = sha256(prev_checkpoint.merkle_root)`.
   Absence of events is evidence for continuous audit; do not skip.
3. Balanced binary Merkle tree over leaf hashes in `tenant_seq` order.
4. Canonical checkpoint bundle:
   `{stream_id, epoch_index, first_seq, last_seq, merkle_root, prev_checkpoint_id, created_at}`
5. Sign Ed25519 (or fallback ECDSA) via OCI Vault callback.
6. If `tsa_mode != 'none'`: submit `sha256(bundle)` to configured TSA endpoint,
   store DER TimeStampToken. Non-blocking (COALESCE); retry queue back-fills.
7. `checkpoint_id = 'CKP_' + first 8 hex of sha256(merkle_root)`.
8. Set `prev_checkpoint` for consistency chain.

### 6.5 Anchor service (Tier 2)

Every `anchor_epoch_secs`:

1. Group unanchored checkpoints across all streams sharing this epoch cadence.
2. Build super-root: balanced tree over checkpoint merkle_roots ordered by
   `(stream_id, epoch_index)`.
3. Feed super-root into existing three-anchor pipeline (RVN issuance, IPFS pin,
   Arweave record) with label `SCR_ANC_<anchor_id>`.
4. COALESCE unchanged — partial anchor sets are valid, retries monotonically
   complete.
5. Mark included checkpoints `anchored_in = anchor_id`.

## 7. Reference Verifier CLI

`scruple-verify` — standalone Node CLI, zero runtime dependency on any Docent
service beyond public-ledger reads. Ships in `packages/scruple-verify/` and as
an npm-published binary. **This CLI is the product's credibility; it is on the
critical path for Sprint 1, not a post-launch nicety.**

### 7.1 Command surface

```
scruple-verify leaf <leaf-file.json> <proof-bundle.json>
    # Full end-to-end verification of one leaf.

scruple-verify consistency <proof-a.json> <proof-b.json>
    # Verify epoch_b's tree is an append-only extension of epoch_a's.

scruple-verify c2pa <signed-asset.png> [--fetch-leaf]
    # C2PA-specific: parse the JUMBF, extract the Scruple SCR-ID assertion,
    # optionally fetch the leaf proof from /v1/proof/leaf/..., verify the
    # C2PA signature AND the Scruple sign-event leaf.

scruple-verify trust-manifest
    # Fetch + validate the Scruple witness trust manifest (issuer chain +
    # currently-valid checkpoint pubkeys).
```

### 7.2 Verification steps performed

1. Recompute leaf hash from the canonical leaf.
2. Walk inclusion proof siblings, recompute Merkle root.
3. Verify checkpoint Ed25519/ECDSA signature against a currently-trusted
   witness pubkey from the trust manifest.
4. If `tsa_token` present: parse RFC 3161 TimeStampToken, validate cert chain
   against system trust store or configured TSA CA bundle, verify hash
   commitment matches `sha256(canonical checkpoint bundle)`.
5. Walk super-root inclusion path.
6. Fetch RVN transaction (via public block explorer or a passed RPC URL),
   confirm super-root embedded in asset issuance metadata.
7. Fetch Arweave record, confirm super-root matches.
8. Optionally fetch IPFS pin, confirm content-address matches the epoch proof
   JSON's hash.
9. Exit 0 if all checks pass; nonzero + human-readable diagnostic if not.

### 7.3 Offline mode

`--offline` accepts pre-fetched RVN + Arweave + IPFS responses on disk. Enables
"verify from a proof-bundle archive on a laptop with no internet." This is what
the Rider §4 "Principal direct access" clause promises operationally.

## 8. Assurance Tiers

Per-stream configuration; presets over three columns. Custom values allowed.

| Tier | `checkpoint_secs` | `tsa_mode` | `anchor_epoch_secs` | Intended buyer |
|---|---|---|---|---|
| `standard` | 3600 (1h) | `none` | 86400 (24h) | Wrapper SaaS, avatar video, individual Scruple artists |
| `enhanced` | 300 (5m) | `rfc3161` (any TSA) | 3600 (1h) | Voice platforms, imagery pipelines, mid-market vendors |
| `qualified` | 60 (1m) | `rfc3161_qualified` (eIDAS TSA) | 3600 (1h) | Finance, health, legal, EU AI Act Article 50 compliance |

**The interval is the assurance dial.** Vendor-facing copy must state that the
unanchored window between checkpoints is the exposure being purchased down.

The default C2PA sign stream (`scruple.c2pa.sign`) runs at `enhanced` tier by
default; individual-artist accounts on the free/pro tier can be downgraded to
`standard`; enterprise accounts default to `qualified`.

## 9. Zero-Content Posture

**Normative and EU-facing.** The witness stores no content — no payloads, no
prompts, no media, no personal data — only one-way cryptographic commitments
(leaf hashes, chain hashes, Merkle roots, checkpoint signatures, TSA tokens,
anchor references).

Enforcement mechanisms:

- Ingest schema validation rejects `payload_bytes` on any stream not carrying
  `preserve_at_witness=true`, which itself is prohibited by config validation
  at `enhanced` and `qualified` tier.
- `meta` envelope is schema-validated against a PII-key denylist (best-effort:
  `name`, `email`, `phone`, `ssn`, `dob`, `address` variants).
- Escalation-layer preservation (Phase 2) is `preserve_in_place` — full-
  resolution bundle written to the **customer's** WORM store, Docent holds
  only the commitment leaf.

Marketing phrasing: **"Scruple stores no content — only proof."**

Legal phrasing (counsel-owned, appears in DPA annex, not in marketing):
Docent holds no re-identification means; identifiability under GDPR is
assessed from the holder's perspective; the off-chain-data / on-chain-
commitment split matches EDPB blockchain guidance. **Do not use the
absolute phrase "hashes are never personal data."**

## 10. Rider Clause Mapping

Each clause of `Independent_AI_Witnessing_Rider_TEMPLATE.md` mapped to the
system component that satisfies it. If any of these mappings drifts, the
Rider becomes a false representation and this doc must be updated.

| Rider § | Requirement | Satisfied by |
|---|---|---|
| §1 Definitions | "Witnessing Service" | Docent-operated Scruple witness cluster; independence per §3 of this doc |
| §2 Emission Obligation | Contemporaneous emit ≤60s, no filter/sample/suppress, monotonic sequence, gaps reported | `tenant_seq` monotonic per stream; SDK batch cap ≤60s; canonical leaf includes explicit gap flag; ingest rejects out-of-order writes |
| §3(a) Inclusion proofs at Schedule W-1 cadence | Per-event inclusion proof against signed checkpoint | `/v1/proof/leaf/{stream_id}/{tenant_seq}` returns bundle; §6.4 checkpoint service |
| §3(b) Qualified electronic timestamps | eIDAS Art. 42 / RFC 3161 on each checkpoint | `qualified` tier `tsa_mode=rfc3161_qualified`; TSA vendor procured under WO-11 |
| §3(c) At least two independent public ledgers | Anchoring to two+ chains | RVN + Arweave (both independent public ledgers with issuance/txid discoverability). IPFS is a content-addressable store, NOT counted as a ledger for this clause |
| §3(d) Consistency proofs | Append-only demonstrable | `/v1/proof/consistency/{stream_id}/{epoch_a}/{epoch_b}`; `prev_checkpoint` chain |
| §3(e) Offline-capable reference verifier | Standalone verifier | `scruple-verify` CLI (§7) |
| §4 Principal Direct Access | Verification cred issued directly, revocable delegation, free export on revoke | `principals` table with independent read-key; `/v1/principal/*` endpoints scoped by principal auth; auto-export on delegation revoke |
| §5 Data Handling | Zero-content default; vendor WORM retention | §9 posture; leaf schema hash-only default |
| §6 Records as Evidence | Records + payloads = authoritative between parties | Proof bundle format documented in `scruple-verify` docs; witness cooperates with regulator-initiated verification per contract |
| §7 Compliance Mapping | Supports EU AI Act Article 50 | `qualified` tier + eIDAS TSA + zero-content posture; mapping doc in `docs/architecture/eu-ai-act-mapping.md` (Sprint 3 deliverable) |
| §8 Failure / Remedies | 0.1%/month unavailability = material breach | Emission-side SLO monitoring + on-call rotation; internal SLA target ≥99.95% |
| §9 Survival | §§4–6 survive termination for retention period | Proof-bundle export on revoke; retention_days honored per-stream |

## 11. C2PA L2 Evidence Checklist

The list below is what the Conformance Program submission must be able to
point at. Each item maps to a work order.

| # | L2 requirement | Evidence artifact | WO |
|---|---|---|---|
| 1 | HSM-backed non-exportable signing key | OCI Vault key OCID + Vault console screenshot showing "Protection Mode: Virtual Private" + OCI Audit sample of Sign call | WO-01 |
| 2 | Production C2PA-trust-list-issued cert | Cert PEM + issuer CA + trust-list linkage | WO-02 |
| 3 | Signer callback path (raw key never in memory) | Code diff on `sign.py` from `from_info` to `from_callback` | WO-03 |
| 4 | Signer process isolation | systemd unit + IAM policy JSON + `ls -l /run/scruple-signer.sock` showing 0660 | WO-04 |
| 5 | Per-sign audit log with third-party witness | Leaf ID for a sample sign event + inclusion proof + checkpoint sig + TSA token + anchor references (all verifiable via `scruple-verify c2pa`) | WO-08, WO-12 |
| 6 | Rate limiting on signing route | Config + rate-limit test result | WO-04 |
| 7 | Key lifecycle documentation | `docs/architecture/lifecycle/*.md` — generation, rotation, revocation, incident response | WO-17 |
| 8 | Interop against production path | C2PA interop v2 report: sign via OCI-Vault path → verify with c2pa-python + c2pa-node + c2patool + `scruple-verify c2pa` | WO-15, WO-18 |
| 9 | CI conformance gate | `.github/workflows/c2pa-conformance.yml` running on every PR; artifact of last passing run | WO-16 |
| 10 | Security policy document | `docs/architecture/security-policy.md` covering the above | WO-17 |

## 12. Rollout Plan (Sprints)

### Sprint 1 — Vendor-demoable core (target: 5-7 days)

Deliverable: **a vendor demo can sign an asset, watch the sign event appear as
a leaf, and independently verify it with `scruple-verify c2pa` against the
public ledger, without touching any Scruple-hosted UI.**

- WO-01 OCI Vault provisioning (both keys, IAM, audit archive)
- WO-02 C2PA cert application (issuer clock starts — long lead time)
- WO-03 Signer refactor to Vault callback
- WO-04 Signer process isolation (systemd + socket + rate limits)
- WO-05 Audit API schema migration + canonical leaf v23 + parity tests
- WO-06 `/v1/log` ingest + HMAC middleware + `POST /v1/streams`
- WO-07 Checkpoint scheduler + Ed25519 signing + heartbeats + consistency chain
- WO-08 C2PA signer emits leaves to `scruple.c2pa.sign` stream
- WO-09 `scruple-verify` CLI v1: `leaf`, `c2pa`, `trust-manifest` subcommands
- WO-10 Sprint 1 E2E smoke + demo script

### Sprint 2 — Rider compliance + timestamps (target: weeks 2-3)

- WO-11 RFC 3161 TSA client + qualified TSA vendor selection + retry queue
- WO-12 Super-root anchoring scheduler + wire to existing RVN/IPFS/Arweave
- WO-13 Proof API — `/v1/proof/consistency` + full principal-scope endpoints
- WO-14 Principal onboarding flow (invite → direct read-key issuance)
- WO-15 SDK `@scruple/log` npm publish + canonicalization parity guarantee

### Sprint 3 — Evidence + polish (target: weeks 3-4)

- WO-16 CI conformance gate: manifest round-trip + interop + audit-trail check
- WO-17 Lifecycle docs (generation, rotation, revocation, incident response,
  security policy)
- WO-18 L2 evidence package assembly + interop test v2 + Conformance submission

### Sprint 4 — Phase 2 escalation (weeks 4-8, flagged, gated)

- WO-19 Deterministic rules engine + `_scruple.escalations` reserved stream
- WO-20 LLM triage worker in `customer_perimeter` mode (customer-VPC deploy)
- WO-21 Preservation directive protocol + `preserve_in_place` action

## 13. Open Questions (owner: Shaun)

Carried forward from the Continuous Audit design doc + new ones from this
consolidation.

- **Qualified TSA vendor selection.** DigiCert / GlobalSign / Sectigo /
  Namirial / InfoCert all publish qualified TSAs on the EU LOTL. Cost per
  stamp and SLA differ. Decide before WO-11.
- **Per-principal billing model.** Metered on the tenant with principal
  attribution, OR direct principal subscription with tenant as free emitter.
  Recommendation from §12 of the audit design doc: the latter — the
  accountable party pays, the vendor has no cost excuse.
- **Principal onboarding UX.** Invite flow: vendor names principal → Docent
  issues read credential directly to principal contact, never through the
  vendor. Detailed UI design in WO-14.
- **Witness Ed25519 vs ECDSA fallback.** Confirm OCI Vault production support
  for Ed25519 asymmetric at provisioning time; if unavailable, use
  ECDSA_NIST_P256 for the checkpoint signer. Verifier CLI supports both.
- **Migration path SQLite → Postgres.** Design ports one-to-one but Postgres
  gives us array types + partial indices + generated columns that make the
  scaled deployment cleaner. Target: post-Sprint 3, before first paying
  enterprise principal.
- **Patent implications.** Hierarchical checkpointing (event chain → interval
  root → qualified timestamp → epoch multi-ledger anchor, interval as tunable
  assurance parameter) and escalate-only LLM triage with self-witnessed
  verdicts — new chapter candidates; do not fold into approved chapters
  without patent-counsel review.

## 14. Non-Compaction-Loss Discipline

If a future session comes into this project without the full context of the
2026-07-12 sessions, everything needed to continue is in this doc plus the
WO index at `docs/wo/2026-07-12-witnessing-l2/INDEX.md`. Specifically:

- The trust model (§3), key custody (§4), and Rider mapping (§10) are
  the load-bearing decisions. Do not re-derive.
- The C2PA L2 evidence checklist (§11) is the acceptance criterion for the
  Conformance Program submission. Do not add or drop items without updating
  §10 and the Conformance Program submission plan in Sprint 3.
- Zero-content posture (§9) is a load-bearing product claim. Any code review
  that permits a persistence path outside the whitelisted preserve-in-place
  action MUST reject the change.
- The three-party geometry (Principal / Tenant / Witness) applies to every
  API surface. If a future endpoint gives a tenant access to a principal's
  read side without an active delegation, that endpoint is broken.
- The reference verifier CLI is on the critical path. If future work delays
  Sprint 1 items, the CLI is the LAST thing to cut, not the first — without
  it, the entire evidence claim collapses to "trust us."

## 15. Attestation Abstraction Layer

**Status:** design entry point. Interface + provider list captured here so the
Sprint 1 signer daemon is shaped to accept providers. Concrete provider modules
(other than the OCI baseline) are NOT built in Sprint 1–3; they are stood up
opportunistically per §16.

### 15.1 Purpose

The C2PA Conformance Program and enterprise security questionnaires both ask
which attestation method(s) the Generator Product is capable of invoking.
Answering that question truthfully — and expanding the truthful answer as
we grow — requires a single internal seam: every sign operation goes through
one `AttestationProvider` interface, and each supported method is a plugin
behind it. The C2PA form answer is then literally "the modules that are green,"
not a marketing claim.

### 15.2 The interface (conceptual)

Every provider fulfills the same contract:

- Input: sign operation context (asset hash, output manifest hash, cert
  serial, KMS key handle, deployment topology, timestamp).
- Output: an attestation evidence bundle in **IETF RATS Conceptual Message**
  format (the vendor-neutral wrapper), plus a provider-native evidence blob
  when the consuming verifier expects the raw cloud-vendor format.

Wrapping every provider's output in RATS keeps the verifier CLI and the
evidence-package assembly logic uniform regardless of which provider produced
the evidence — RATS is the interoperable layer, native blobs are attached for
consumers that need them.

### 15.3 Provider catalog

| Provider ID | Attestation source | Cloud requirement | Purpose |
|---|---|---|---|
| `rats-oci-scc` | RATS Evidence wrapping OCI Confidential Compute attestation (AMD SEV-SNP) | OCI Confidential Compute VM | Default for `scruple-hosted-oci` topology; produces vendor-neutral evidence |
| `rats-scruple-ledger` | RATS Evidence citing the witness-emitted sign leaf + inclusion proof + super-root anchor on RVN + Arweave | None (independent of cloud) | Peer attestation from our own audit chain — the differentiator no C2PA-listed provider can produce; usable in ALL topologies |
| `aws-nitro` | AWS Nitro Enclave attestation document + AWS KMS key attestation | AWS EC2 with Nitro Enclave | For `scruple-hosted-aws` and `customer-perimeter-aws` topologies |
| `azure-mhsm` | Azure Managed HSM key attestation | Azure MHSM | Key-in-HSM attestation; typically paired with `azure-attestation` |
| `azure-attestation` | Microsoft Azure Attestation TEE report | Azure Confidential Computing VM | Broader TEE attestation for the signer workload |
| `gcp-cloudhsm` | GCP Cloud HSM key attestation | GCP Cloud HSM | Key-in-HSM attestation |
| `gcp-confidential-vm` | GCP Confidential VM attestation (AMD SEV / Intel TDX) | GCP Confidential VM | TEE attestation for the signer workload |

**Deferred, gated on separate product direction:**

- `android-keyattestation`, `google-playintegrity`, `apple-appattest`,
  `qualcomm-wes` — device-side attestation. Only relevant if Scruple ships
  a capture-authenticity product (mobile SDK signing at point of capture).
  Not built until that strategic direction is committed. Adding the
  interface hook here so a future capture-authenticity SDK plugs in without
  a rewrite.

### 15.4 C2PA form answer maps to green providers

The Conformance question "Please select the key and/or integrity attestation
method(s) that your Generator Product is capable of invoking" answers as a
union of currently-green providers. Timeline:

- **After Sprint 1**: `IETF_RATS` (via `rats-oci-scc` and `rats-scruple-ledger`).
  Both providers are honest, both produce verifiable evidence, and both align
  with our OCI-hosted baseline.
- **Later**: each cloud-vendor provider becomes truthful when its satellite
  topology is stood up (see §16) — not before.

Never assert a provider we cannot demonstrate on the day of filing. Same rule
as the L2 assurance-level assertion in §11.

### 15.5 Invariants

- **RATS is the interop wrapper for every provider.** No provider produces
  only its native blob; all wrap into a RATS Evidence claim so the verifier
  CLI has one code path.
- **`rats-scruple-ledger` is always available.** It depends only on our own
  audit chain, not any cloud. It is emitted as an additional attestation
  alongside whatever provider matches the deployment topology.
- **Providers are stateless.** No provider stores credentials or state
  outside its module boundary. Cloud creds come from the topology's ambient
  identity (OCI Dynamic Group, AWS IAM Role, Azure Managed Identity, GCP
  Workload Identity).

## 16. Signer Deployment Topologies

**Status:** design entry point. Topology catalog defines where the signer
daemon can run and which attestation providers each topology naturally
lights up. Sprint 1 stands up only `scruple-hosted-oci`. Other topologies
are stood up opportunistically as customer demand justifies the ops cost.

### 16.1 Purpose

Enterprise procurement matrices ask "does this vendor run on AWS/Azure/GCP?"
regardless of whether the technical architecture would prefer single-cloud.
For the deals where the checkbox is a conversion barrier, Scruple must be
able to answer "yes" for that cloud on 48-hour notice. The seven-topology
design lets us answer honestly without maintaining three parallel production
stacks unless a paying customer justifies the ongoing ops cost per cloud.

### 16.2 Topology catalog

| Topology | Ops owner | Signer runs in | Keys in | Attestation providers lit | When to stand up |
|---|---|---|---|---|---|
| `scruple-hosted-oci` | Scruple | OCI Confidential Compute VM (dedicated compartment, see §4) | OCI Vault Virtual Private (§4.1) | `rats-oci-scc` + `rats-scruple-ledger` | Sprint 1 baseline |
| `scruple-hosted-aws` | Scruple | Scruple-owned AWS account, Nitro Enclave on EC2 | AWS KMS asymmetric | `aws-nitro` + `rats-scruple-ledger` | On first regulated-AWS deal demanding the checkbox |
| `scruple-hosted-azure` | Scruple | Scruple-owned Azure subscription, Confidential Computing VM | Azure Managed HSM | `azure-mhsm` + `azure-attestation` + `rats-scruple-ledger` | On first regulated-Azure deal demanding the checkbox |
| `scruple-hosted-gcp` | Scruple | Scruple-owned GCP project, Confidential VM | GCP Cloud HSM | `gcp-cloudhsm` + `gcp-confidential-vm` + `rats-scruple-ledger` | On first regulated-GCP deal demanding the checkbox |
| `customer-perimeter-aws` | Customer | Customer's AWS account, Nitro Enclave | Customer's AWS KMS | `aws-nitro` + `rats-scruple-ledger` | On first customer that self-hosts (technically-sophisticated buyer) |
| `customer-perimeter-azure` | Customer | Customer's Azure subscription | Customer's Azure MHSM | `azure-mhsm` + `azure-attestation` + `rats-scruple-ledger` | Same shape |
| `customer-perimeter-gcp` | Customer | Customer's GCP project | Customer's GCP Cloud HSM | `gcp-cloudhsm` + `gcp-confidential-vm` + `rats-scruple-ledger` | Same shape |

### 16.3 The satellite invariant

Non-OCI topologies are **signing satellites**, not independent Scruples.
Every sign event from every satellite writes to the **OCI-hosted witness
stream** `scruple.c2pa.sign`. There is exactly one:

- Audit API instance (OCI).
- Checkpoint scheduler (OCI).
- Anchor pipeline (RVN + IPFS + Arweave, driven from OCI).
- Reference verifier trust manifest (published from OCI at
  `scruple.stooges.ai/.well-known/witness-trust.json`).

A satellite is a signing endpoint that reports home to the canonical witness.
This keeps the L2 evidence chain unified regardless of how many satellites
are live. The satellite's local key is a different key OCID than the OCI
baseline's, but both keys' public halves and both keys' provenance are
declared in the trust manifest, so any verifier can identify which key
signed a given C2PA asset and confirm the satellite's authorization.

### 16.4 Trust manifest per deployment

Each topology publishes into the trust manifest:

- Topology ID (`scruple-hosted-aws`, etc.).
- Signer public key + key custody description (OCI Vault OCID, AWS KMS ARN, etc.).
- Attestation providers advertised for this topology.
- Deployment activation date + region.
- Deprecation date (null when active).

Verifiers pull the manifest, walk the C2PA cert to the topology entry, and
know exactly what security posture backs the signature. The manifest itself
is Ed25519-signed by the witness root key (§4.1) so a compromised satellite
cannot forge trust-manifest entries.

### 16.5 Gating rule

- **Code for all topologies ships in the packaging WO** (later work order,
  post-Sprint-3, filed when a specific deal justifies pulling it forward).
  Single-binary signer daemon, deployment mode chosen by config.
- **Infrastructure for non-OCI Scruple-hosted topologies stands up only when
  a paying deal demands the specific cloud's checkbox.** Target: 48 hours
  from decision to satellite live.
- **Customer-perimeter topologies** are packaging + docs, not Scruple-operated
  infrastructure. Ship when the first customer requests the install package.

### 16.6 Ops cost per Scruple-hosted satellite (order-of-magnitude)

- Compute: one small confidential-computing VM per region (~$100/mo).
- Key custody: one HSM key (~$3–$10/mo depending on cloud).
- Audit archive: cloud-native (CloudTrail / Azure Activity Log / GCP Audit
  Logs) forwarded to that cloud's Object Storage compliance-mode bucket
  (~$10/mo).
- Human ops: quarterly access review per satellite; incident-response
  rotation coverage; L2 evidence pack update per satellite per year.

Order-of-magnitude: ~$150/mo infrastructure + ~2 person-days/quarter per
satellite. Cheap per satellite; the discipline is not spinning up all three
speculatively.

### 16.7 Non-goals

- Do not run the audit API, checkpoint scheduler, or anchor pipeline in
  any non-OCI topology. Satellite = signer only.
- Do not fork the codebase per topology. Single binary, config-driven
  deployment mode.
- Do not advertise a topology on the trust manifest before it is live and
  passing the reference verifier CLI end-to-end.

## 17. Related documents

- `docs/architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md` — schema + leaf +
  API surface details, still authoritative for those sections
- `docs/architecture/Independent_AI_Witnessing_Rider_TEMPLATE.md` — customer
  contract template that this system satisfies
- `docs/c2pa-interop/2026-07-12-interop-test-report.md` — L1 interop evidence
- `docs/architecture/canvas-v2.md` — existing canvas/witness scaffold this
  builds on
- `docs/wo/2026-07-12-witnessing-l2/INDEX.md` — WO manifest for this build
- `docs/architecture/lifecycle/` — key lifecycle runbooks (Sprint 3 output)
- `docs/architecture/security-policy.md` — L2 security policy (Sprint 3 output)
- `docs/architecture/eu-ai-act-mapping.md` — Article 50 mapping (Sprint 3 output)
