# Scruple Continuous Audit API — Design Document

**Component name:** Scruple Log (working name; a.k.a. "the tunnel")
**Target codebase:** Scruple Web Studio (witness server + web side)
**Status:** DESIGN — for implementation by Claude Code
**Doc version:** 0.1 (2026-07-10)
**Depends on (existing, DO NOT rewrite):** `canonicalRecordV22()` canonicalization, five-hash receipt construction (`ingest.ts`), Merkle chain assembly, SCR-ID derivation, three-anchor pipeline (`testnet-locker.js`, `ipfs-pinner.js`, `arweave-treasury.js`), COALESCE write-back resilience.

---

## 1. Purpose

Give any vendor a **one-endpoint way to stream audit events into the Scruple witness**, with a per-vendor configuration of:

1. **Log points** — named event streams the vendor declares (e.g. `voice.call.disclosure`, `agent.tool_call`, `gen.image.output`).
2. **Interval** — the checkpoint cadence that converts raw events into signed, timestamped Merkle roots.
3. **Assurance tier** — how often checkpoints happen, whether each checkpoint gets a qualified RFC 3161 timestamp, and how often checkpoint roots are anchored on-chain.

The witness server, on receiving a tenant's configuration, is **immediately ready to receive** on those streams. No per-vendor code.

This implements the three-tier transparency-log architecture:

```
Tier 0  HOT LOG      per event      append-only, hash-chained rows (Postgres)
Tier 1  CHECKPOINT   per interval   Merkle root over batch + witness signature
                                    + optional RFC 3161 (eIDAS-qualified TSA)
Tier 2  ANCHOR       per epoch      root-of-roots → existing RVN + IPFS + Arweave
```

Design consequence: **RVN transaction count is a function of wall-clock time, not event volume.** Hourly anchoring = 8,760 tx/year whether the year held 10^4 or 10^10 events.

## 2. Non-goals (Phase 1)

- **No enforcement / gating.** Phase 1 records; it never blocks. (Jailbird escalation in §10 raises *resolution*, never suppresses or blocks.)
- **No raw content custody by default.** Docent stores hashes and minimal metadata. Raw payloads (prompts, audio, PII) remain in the **vendor's** WORM store (S3 Object Lock compliance mode or equivalent). See §8.
- **Not a SIEM.** No search-over-content, no alerting UX beyond escalation flags.
- **No new canonicalization scheme.** Reuse `canonicalRecordV22` field-ordering discipline; extend with a v23 leaf schema (§5.1), same rules (fixed field order, compact JSON, empty-string defaults).

## 3. Actors & trust boundaries

| Actor | Holds | Must NOT hold |
|---|---|---|
| Vendor (tenant) | Raw event payloads in own WORM store; API key | Ability to mutate the log |
| Scruple witness (Docent-operated) | Hash leaves, chains, checkpoints, anchors, signing keys | Raw PII/content (default) |
| Public ledgers | Checkpoint-epoch roots | Anything reversible |
| Verifier (anyone) | Proof bundles | Nothing privileged |

Independence invariant: **the party being audited never operates the log; the log operator never holds the data.** Deleting a vendor-side record (GDPR erasure) orphans a hash that proves nothing about any person — erasure-compatible immutability.

## 4. Tenants, principals & stream configuration

### 4.0 Principals & delegation (three-party geometry)

In the dominant deployment pattern, the **tenant** (API caller) is a third-party vendor operating an AI stack on behalf of the party that carries the legal duty. The schema must encode all three roles:

- **Principal** — the end enterprise with the Article 50 / audit obligation and the verification right.
- **Tenant (vendor)** — the operator that emits events. Logs *on behalf of* one or more principals under revocable delegation.
- **Witness** — Docent. Unchanged.

Rules:

1. Every leaf MAY carry a `principal_id`; streams declare `principal_mode`: `'none'` (vendor logs for itself), `'fixed'` (one principal per stream), or `'per_leaf'`.
2. A **delegation** record authorizes a tenant to log for a principal, is revocable by the principal, and its creation/revocation events are themselves written to reserved stream `_scruple.delegations` (governance is witnessed like everything else).
3. The principal receives its **own read/verify credential** that does not pass through the vendor: proofs, consistency checks, and exports are retrievable by the principal directly. This is what makes contractual audit-rights clauses self-executing.
4. **Portability:** a principal may export the complete proof-bundle set for its leaves at any time (and automatically on delegation revocation), so the record survives a vendor switch.
5. Billing attribution rides `principal_id` (per-principal metering within a tenant).

```sql
CREATE TABLE principals (
  principal_id     TEXT PRIMARY KEY,          -- 'PRN_' + 8 hex
  name             TEXT NOT NULL,
  read_key_hash    TEXT NOT NULL,             -- argon2(read/verify API key)
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE delegations (
  delegation_id    TEXT PRIMARY KEY,          -- 'DLG_' + 8 hex
  principal_id     TEXT NOT NULL REFERENCES principals,
  tenant_id        TEXT NOT NULL REFERENCES tenants,
  scope_streams    TEXT[],                    -- null = all tenant streams
  status           TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'revoked'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at       TIMESTAMPTZ,
  UNIQUE (principal_id, tenant_id)
);
```

### 4.1 Data model (new tables)

```sql
-- migrations/00X_scruple_log.sql

CREATE TABLE tenants (
  tenant_id        TEXT PRIMARY KEY,          -- 'TEN_' + 8 hex (SCR-ID style)
  name             TEXT NOT NULL,
  api_key_hash     TEXT NOT NULL,             -- argon2(api_key)
  hmac_secret      TEXT NOT NULL,             -- per-tenant request signing secret
  status           TEXT NOT NULL DEFAULT 'active',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE streams (
  stream_id        TEXT PRIMARY KEY,          -- 'STR_' + 8 hex
  tenant_id        TEXT NOT NULL REFERENCES tenants,
  name             TEXT NOT NULL,             -- 'agent.tool_call'
  schema_hint      JSONB,                     -- optional declared leaf fields
  checkpoint_secs  INTEGER NOT NULL DEFAULT 300,   -- the vendor-chosen INTERVAL
  tsa_mode         TEXT NOT NULL DEFAULT 'none',   -- 'none' | 'rfc3161' | 'rfc3161_qualified'
  tsa_url          TEXT,                      -- e.g. qualified TSA endpoint
  anchor_epoch_secs INTEGER NOT NULL DEFAULT 3600, -- Tier-2 cadence
  retention_days   INTEGER NOT NULL DEFAULT 2555,  -- 7y default, financial-records posture
  principal_mode   TEXT NOT NULL DEFAULT 'none',   -- 'none' | 'fixed' | 'per_leaf' (§4.0)
  fixed_principal  TEXT REFERENCES principals,     -- required when principal_mode='fixed'
  escalation_policy JSONB,                    -- §10 menu; null = off
  UNIQUE (tenant_id, name)
);

CREATE TABLE log_leaves (
  leaf_seq         BIGINT GENERATED ALWAYS AS IDENTITY,
  stream_id        TEXT NOT NULL REFERENCES streams,
  principal_id     TEXT REFERENCES principals,  -- §4.0; required when stream principal_mode != 'none'
  tenant_seq       BIGINT NOT NULL,           -- vendor-supplied monotonic sequence
  leaf_hash        BYTEA NOT NULL,            -- sha256(canonical leaf, §5.1)
  prev_chain_hash  BYTEA NOT NULL,            -- running hash chain per stream
  chain_hash       BYTEA NOT NULL,            -- sha256(prev_chain_hash || leaf_hash)
  received_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  idempotency_key  TEXT NOT NULL,
  escalated        BOOLEAN NOT NULL DEFAULT false,
  meta             JSONB,                     -- non-sensitive envelope fields only
  PRIMARY KEY (stream_id, tenant_seq),
  UNIQUE (stream_id, idempotency_key)
);
CREATE INDEX ON log_leaves (stream_id, leaf_seq);

CREATE TABLE checkpoints (
  checkpoint_id    TEXT PRIMARY KEY,          -- 'CKP_' + 8 hex of sha256(root)
  stream_id        TEXT NOT NULL REFERENCES streams,
  epoch_index      BIGINT NOT NULL,           -- monotonic per stream
  first_seq        BIGINT NOT NULL,
  last_seq         BIGINT NOT NULL,
  merkle_root      BYTEA NOT NULL,            -- balanced tree over leaf_hashes in range
  prev_checkpoint  TEXT,                      -- consistency chain
  witness_sig      BYTEA NOT NULL,            -- Ed25519 over canonical checkpoint bundle
  tsa_token        BYTEA,                     -- DER TimeStampToken when tsa_mode != none
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  anchored_in      TEXT,                      -- FK → anchor_epochs when included
  UNIQUE (stream_id, epoch_index)
);

CREATE TABLE anchor_epochs (
  anchor_id        TEXT PRIMARY KEY,          -- 'ANC_' + 8 hex of sha256(super_root)
  super_root       BYTEA NOT NULL,            -- Merkle root over checkpoint roots in epoch
  checkpoint_count INTEGER NOT NULL,
  rvn_txid         TEXT,                      -- COALESCE semantics, non-blocking
  ipfs_cid         TEXT,
  arweave_id       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 4.2 Assurance tiers (menu presented to vendors)

| Tier | checkpoint_secs | tsa_mode | anchor_epoch_secs | Intended buyer |
|---|---|---|---|---|
| `standard` | 3600 | none | 86400 (daily) | wrapper SaaS, avatar video |
| `enhanced` | 300 | rfc3161 | 3600 (hourly) | voice platforms, imagery pipelines |
| `qualified` | 60 | rfc3161_qualified (eIDAS TSA) | 3600 | finance, health, legal |

Tiers are presets over the same three columns; custom values allowed. **The interval is the assurance dial** — document in vendor-facing copy that the unanchored window between checkpoints is the exposure being purchased down.

## 5. Ingestion API

Base path: `/v1/log`. Auth: `Authorization: Bearer <api_key>` **plus** HMAC-SHA256 request signature header `X-Scruple-Signature` over `(timestamp || body)` with the tenant `hmac_secret`; reject clock skew > 5 min. All endpoints idempotent.

### 5.1 Leaf schema (canonical, v23)

The vendor may send **hash-only** (default, recommended) or **full-payload** (Docent hashes it and discards unless `preserve` requested — see §10).

```jsonc
POST /v1/log/{stream_name}
{
  "tenant_seq": 918273,                  // REQUIRED monotonic per stream
  "idempotency_key": "uuid-or-vendor-id",// REQUIRED
  "principal_id": "PRN_9F8E7D6C",        // REQUIRED when stream principal_mode='per_leaf';
                                         // server validates an active delegation (§4.0)
  "event_time": "2026-07-10T14:03:22.114Z",
  "payload_hash": "sha256:ab12...",      // REQUIRED in hash-only mode
  "payload_bytes": null,                 // base64; full-payload mode only
  "dims": {                              // OPTIONAL extra committed dimensions,
    "input_hash":  "sha256:...",         // mirrors five-hash discipline
    "output_hash": "sha256:...",
    "model_fingerprint_hash": "sha256:...",
    "workflow_hash": "sha256:...",
    "machine_manifest_hash": "sha256:..."
  },
  "meta": { "region": "eu-west", "kind": "tool_call" }  // NON-SENSITIVE only
}
```

Canonical leaf preimage = `canonicalLeafV23({tenant_id, principal_id, stream_id, tenant_seq, event_time, payload_hash, dims})` — same canonicalization rules as `canonicalRecordV22` (fixed field order, compact JSON, empty-string defaults; `principal_id` empty string when absent). `leaf_hash = sha256(preimage)`. Leaves citing a revoked or missing delegation are **rejected at ingest** (401 `delegation_inactive`) — a vendor cannot manufacture record history for a principal that has withdrawn authorization.

**Response (200):**
```json
{ "leaf": { "stream_id": "STR_1A2B3C4D", "tenant_seq": 918273,
            "leaf_hash": "sha256:...", "chain_hash": "sha256:...",
            "pending_checkpoint_epoch": 4412 } }
```

### 5.2 Batch ingest

`POST /v1/log/{stream_name}/batch` — array of ≤ 1000 leaves, same schema. Server validates `tenant_seq` contiguity per stream; gaps are accepted but recorded in `meta.gap=true` on the following leaf (gaps are evidence, not errors).

### 5.3 Config endpoints

```
POST   /v1/streams                 create/update stream (name, checkpoint_secs, tsa_mode, anchor_epoch_secs, escalation_policy)
GET    /v1/streams                 list tenant streams + current epoch state
POST   /v1/tenants  (admin only)   provision tenant, returns api_key + hmac_secret once
```

Stream creation is the entire onboarding: **declare a log point + interval → witness is ready.**

### 5.4 Operational limits

- Rate limit per tenant (config, default 500 req/s; batch counts as N leaves).
- Backpressure: 429 with `Retry-After`. Vendors MUST queue locally; SDK (§9) does.
- Ingest write path is: validate → canonical hash → single INSERT. No Merkle work inline. Target p99 < 15 ms.

## 6. Checkpoint service (Tier 1)

A scheduler (BullMQ repeatable job or `setInterval` per active stream — prefer BullMQ; survives restarts) runs per stream every `checkpoint_secs`:

1. Select leaves `(last_checkpoint.last_seq, current_max_seq]`. If empty, emit **heartbeat checkpoint** (root over empty set = hash of previous root; proves liveness and absence of events — absence is evidence for continuous audit).
2. Build **balanced binary Merkle tree** over `leaf_hash` in `tenant_seq` order (reuse existing Merkle module; linear-chain fallback acceptable but balanced tree required for O(log n) inclusion proofs at billions scale).
3. Canonical checkpoint bundle `{stream_id, epoch_index, first_seq, last_seq, merkle_root, prev_checkpoint_id, created_at}` → sign Ed25519 with witness key (same key custody model as existing witness signature).
4. If `tsa_mode != none`: submit `sha256(bundle)` to configured TSA (RFC 3161 TimeStampReq over HTTPS); store DER token. Qualified endpoints configurable via env (`TSA_QUALIFIED_URLS`, comma list; retry across list). TSA failure is **non-blocking** (COALESCE posture): checkpoint stands, `tsa_token` back-filled by retry queue, gap logged.
5. `checkpoint_id = 'CKP_' + first 8 hex of sha256(merkle_root)`.
6. **Consistency:** store `prev_checkpoint`; expose consistency proofs (§8.2) so successive roots are provably append-only extensions (anti-equivocation).

## 7. Anchor service (Tier 2)

Every `anchor_epoch_secs` (global scheduler, groups all streams whose epoch elapsed):

1. Collect unanchored `checkpoints.merkle_root` set → build **super-root** (balanced tree over checkpoint roots, ordered by `(stream_id, epoch_index)`).
2. Feed super-root into the **existing** three-anchor pipeline exactly as a lock root today: RVN asset issuance embedding the root, IPFS pin of the epoch proof JSON (checkpoint list + roots + sigs + TSA tokens), Arweave record `{anchor_id, super_root, rvn_txid, witness_sig, ipfs_cid}`.
3. COALESCE semantics unchanged: partial anchor sets are valid; retries monotonically complete; nothing invalidates.
4. Mark included checkpoints `anchored_in = anchor_id`.

No changes to locker/pinner/treasury modules beyond accepting a caller-supplied root + label.

## 8. Proof & verification API

### 8.1 Inclusion proof

```
GET /v1/proof/leaf/{stream_id}/{tenant_seq}
→ {
  "leaf": {...canonical leaf fields...},
  "inclusion": ["sha256:...", ...],        // ~log2(batch) siblings + positions
  "checkpoint": { bundle, witness_sig, tsa_token? },
  "anchor": { anchor_id, super_root, inclusion_to_super_root: [...],
              rvn_txid, ipfs_cid, arweave_id }
}
```

A billion-leaf epoch ⇒ ~30 hashes ⇒ proof bundle ~1–2 KB. **Verifiable offline** given ledger access.

### 8.2 Consistency proof

`GET /v1/proof/consistency/{stream_id}/{epoch_a}/{epoch_b}` — standard Merkle consistency proof that epoch_b's tree is an append-only extension of epoch_a's.

### 8.3 Principal read & export API (§4.0)

Authenticated with the **principal's** read key (never the vendor's):

```
GET  /v1/principal/leaves?stream=&from=&to=        list own leaves across all delegating tenants
GET  /v1/principal/proof/leaf/{stream_id}/{seq}    same bundle as 8.1, principal-scoped authz
GET  /v1/principal/consistency/...                 as 8.2
POST /v1/principal/export                          async job → complete proof-bundle archive
                                                   (leaves + inclusion paths + checkpoints +
                                                   TSA tokens + anchor refs) as tar.gz;
                                                   auto-triggered on delegation revocation
POST /v1/principal/delegations                     grant/revoke tenant delegations
```

Design invariant: every principal endpoint functions with the vendor's cooperation absent or adversarial. This is the self-executing audit right.

### 8.4 Reference verifier

Extend the existing audit script (parity requirement, as with `canonicalRecordV22`): `scruple-verify leaf.json proof.json` recomputes leaf hash → walks inclusion → checks witness sig → validates RFC 3161 token against TSA cert chain → checks super-root inclusion → confirms root on RVN/Arweave. Ship as standalone Node CLI; no Docent services required to verify. **This CLI is the product's credibility; build it in Phase 1, not later.**

### 8.5 Data-protection posture (must appear in code comments and docs)

**Zero-content architecture (normative, EU-facing).** The witness stores *no content*: no payloads, no prompts, no media, no personal data — only one-way cryptographic commitments (leaf hashes, chain hashes, Merkle roots, checkpoint signatures, TSA tokens, anchor references). This is a load-bearing product claim; any code path that would persist `payload_bytes` outside an explicit, per-stream, contractually-configured `preserve_payload` escalation MUST be rejected in review. Marketing phrasing: "Scruple stores no content — only proof." Legal phrasing (annex, counsel-owned): Docent holds no re-identification means; identifiability is assessed from the holder's perspective; the off-chain-data / on-chain-commitment split matches EDPB blockchain guidance. Do not use the absolute phrase "hashes are never personal data."

- Hash-only default; `meta` is schema-validated to reject obvious PII keys (denylist: name/email/phone/ssn patterns) — best-effort guard, contractually the vendor's duty.
- Raw payloads: vendor WORM store; Docent proof bundle references them only by hash.
- GDPR erasure: vendor deletes payload; leaf remains; document that an orphaned hash of erased content is not personal data processing in the operative sense — but flag for counsel review (Shaun), do not hard-code legal claims into responses.

## 9. Vendor SDK (thin)

`@scruple/log` (TypeScript, ~200 LoC): constructor(apiKey, hmacSecret, baseUrl); `log(stream, event)` computes payload_hash client-side (vendor content never leaves by default), assigns tenant_seq from a local durable counter, queues with retry/backoff, batches at 100 leaves or 1 s. Publish the canonicalization function verbatim so client-side hashes match server recomputation.

## 10. Phase 2 — Jailbird escalation layer (design stub; implement behind flag `ESCALATION_ENABLED`)

Purpose: **higher-resolution logging and preservation** on decision events matching vendor-chosen conditions. Recording-side only in this phase — no gating.

### 10.1 Trust rules (non-negotiable, encode in module docstring)

1. **Escalation can only add.** Any trigger may raise resolution (preserve full payload, tighten interval, pin to IPFS); no component may suppress, redact, or drop a leaf. Monotonicity is what keeps an LLM in the loop safe.
2. **Deterministic layer first.** Rule evaluation (thresholds, categories, regex, allow/deny lists) runs before and independently of any LLM. LLM triage is optional, advisory, escalate-only.
3. **The auditor is audited.** Every escalation decision — rule hit or LLM verdict, including model id, prompt hash, and response hash — is itself written as a leaf on a reserved stream `_scruple.escalations`. The watcher's decisions enter the same chain it guards.
4. Vendor-facing framing: the LLM layer is triage for *preservation*, never a gate; a non-user-addressable path (hardware Jailbird) is the later embodiment of rule evaluation, reachable through this same interface.

### 10.2 escalation_policy schema (the "menu")

```jsonc
{
  "rules": [
    { "when": {"meta.kind": "tool_call", "meta.tool": {"in": ["payments.transfer","records.delete"]}},
      "then": ["preserve_in_place","tighten_interval:60","pin_ipfs"] },
    { "when": {"dims.output_hash": {"novel_vs_stream_days": 30}},
      "then": ["preserve_in_place"] },
    { "when": {"meta.amount_eur": {"gt": 10000}}, "then": ["preserve_in_place","notify"] }
  ],
  "llm_triage": {
    "enabled": false,
    "deployment": "customer_perimeter",    // 'docent_hosted' | 'customer_perimeter' (§10.4)
    "model": "claude-sonnet-4-6",
    "sample_rate": 0.02,                   // fraction of non-rule-hit leaves reviewed
    "criteria": ["possible_pii_exposure","out_of_policy_action","anomalous_sequence"],
    "actions_allowed": ["preserve_in_place","tighten_interval:60","flag"]
  }
}
```

Actions: `preserve_in_place` (DEFAULT and only option at `qualified` tier — the server issues a **preservation directive**; the vendor-side SDK agent writes the full-resolution bundle — payload, prompts, context window, tool args/results — to the *customer's* WORM store and returns `{preservation_hash, storage_ref}`; Docent records only the commitment leaf. `preserve_at_witness` exists solely as an opt-in convenience at `standard` tier, encrypted with a tenant-scoped key, and is prohibited by config validation at `enhanced`/`qualified`), `tighten_interval:<secs>` (temporary checkpoint cadence override, auto-reverts after N epochs), `pin_ipfs` (commitments only, never content), `flag`, `notify` (webhook).

### 10.4 Analysis locality (zero-content, extended)

The triage layer follows the same rule as the log: **analysis stays with the data; only commitments and content-free aggregates leave.**

- `llm_triage.deployment`: `'docent_hosted'` (input restricted to canonical leaf + `meta` + chain metadata — never payloads; suitable when nothing sensitive is in scope) or `'customer_perimeter'` (triage worker + model run inside the customer's VPC or on the Jailbird/TME appliance; full-resolution inputs permitted because nothing leaves).
- In `customer_perimeter` mode, the only objects crossing the boundary to Docent are: the structured verdict `{escalate, actions, rationale_hash, model_id_hash, prompt_hash, response_hash}` (written to `_scruple.escalations` as today) and periodic **aggregate telemetry** — counts, rates, category distributions per stream — with a k-threshold (suppress any aggregate cell with < [20] underlying events) so aggregates cannot reconstruct individual decisions. Rationale *text* is preserved in the customer's WORM store under `preserve_in_place`; Docent holds its hash.
- Consequence to state in vendor-facing docs: the assurance ladder is monotone in privacy as well as proof — the `qualified` tier sends Docent strictly less content (none) than any lower tier, while producing strictly stronger evidence.

### 10.3 LLM triage mechanics

Async worker off the ingest path (never blocks ingest). Input: canonical leaf + `meta` + last K chain entries' meta (no raw payloads unless already preserved). Output: strict JSON `{escalate: bool, actions: [...], rationale_hash}`. Anthropic API call; full request/response hashes logged to `_scruple.escalations` per rule 3. Timeout ⇒ no-op (fail-safe = base resolution, which is already complete at hash level — nothing is ever lost by triage failure, only left at standard resolution).

## 11. Implementation plan (Claude Code milestones)

1. **M1 — Schema + ingest.** Migrations §4.0–4.1 (tenants, principals, delegations, streams, leaves); `/v1/log` single + batch; HMAC auth middleware; delegation validation at ingest; canonicalLeafV23 (+ unit tests proving cross-side hash parity with SDK function); rate limiting.
2. **M2 — Checkpoints.** BullMQ scheduler; balanced Merkle module (or adapt existing); Ed25519 signing; heartbeat checkpoints; consistency chaining. Tests: inclusion + consistency proof round-trips at 10^6 synthetic leaves.
3. **M3 — RFC 3161.** TSA client (TimeStampReq/Resp DER; use `asn1js`/`pkijs`), retry queue, qualified-TSA env config, token verification in verifier CLI.
4. **M4 — Anchoring.** Super-root builder; wire to existing locker/pinner/treasury with label param; COALESCE parity tests.
5. **M5 — Proof API + verifier CLI.** §8 endpoints; standalone `scruple-verify`; docs page with a worked example proof.
6. **M6 — SDK + demo tenant.** `@scruple/log`; seed a demo tenant exercising `standard` and `qualified` tiers; load test 5k leaves/s sustained on the Oracle box; document observed checkpoint latency.
7. **M7 (flagged) — Escalation.** Deterministic rules engine + `_scruple.escalations` stream + preserve/tighten/pin actions. LLM triage last, behind its own flag.

## 12. Open questions (decide before M3/M7; owner: Shaun)

- Qualified TSA vendor selection + per-stamp cost ceiling per tier.
- Per-principal billing model: metered on the tenant with principal attribution, or direct principal subscription with tenant as free emitter (recommend the latter for the enterprise sales motion — the accountable party pays, the vendor has no cost excuse).
- Principal onboarding UX when the vendor initiates (invite flow: vendor names principal → Docent issues read credential directly to principal contact, never through the vendor).
- ~~Whether `preserve_payload` on Docent side is offered at all for `qualified`-tier tenants~~ **RESOLVED 2026-07-10:** qualified tier is `preserve_in_place` only; witness-side preservation prohibited by config validation at enhanced/qualified (§10.4).
- Witness key custody for checkpoint signing: same key as record witness, or per-service subkey with cert chain to the witness root (recommend subkey).
- Patent: hierarchical checkpointing (event chain → interval root → qualified timestamp → epoch multi-ledger anchor, interval as tunable assurance parameter) and escalate-only LLM triage with self-witnessed verdicts — **new chapter candidates; do not fold into approved chapters.**
