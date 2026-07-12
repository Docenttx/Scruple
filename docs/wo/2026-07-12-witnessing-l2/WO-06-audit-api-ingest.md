# WO-06 — Audit API ingest (`/v1/log`, `/v1/streams`) + HMAC middleware + rate limits

**Sprint:** 1
**Estimate:** 10 owner-hours
**Blocking:** WO-05 (schema + canonicalLeafV23 must exist)
**Blocks:** WO-07 (checkpoint scheduler reads from `log_leaves`), WO-08 (C2PA
signer POSTs sign leaves here), WO-09 (verifier CLI reads back via the proof
API which shares middleware/auth)

## Goal

Stand up the write-side of the Continuous Audit API: single-leaf and batch
ingest, stream provisioning, HMAC-authenticated middleware, per-tenant rate
limits, delegation validation. After this WO, a properly-credentialed tenant
can POST leaves and see them land in `log_leaves` with correct chain hashes.

## What to build

### 1. Route tree under `app/api/v1/`

```
app/api/v1/
  log/
    [stream_name]/
      route.ts               # POST single leaf
      batch/
        route.ts             # POST batch (≤ 1000 leaves)
  streams/
    route.ts                 # POST create/update stream; GET list
```

Base auth: `Authorization: Bearer <api_key>` where `<api_key>` is looked
up by `sha256(plaintext) == tenants.api_key_hash`. Missing / invalid / on
a revoked tenant → 401.

### 2. HMAC middleware

Every `/v1/log/*` request must present headers:

- `X-Scruple-Timestamp: <unix seconds>` — reject if `abs(server_now - ts) > 300`
- `X-Scruple-Signature: <hex hmac_sha256>` — computed by the caller as
  `HMAC-SHA256(hmac_secret, f"{timestamp}\n{request_body}")`

Middleware:

- Fetches `tenants.hmac_secret_enc`, decrypts (KEK from OCI Vault; in
  Sprint 1 the KEK can be a static env var placeholder — WO-17 replaces
  with real Vault-held KEK).
- Recomputes signature over `${timestamp}\n${raw body}` (raw body — must read
  the request body ONCE and reuse; do not JSON.parse before signature check).
- Constant-time compare.
- Reject with 401 `invalid_signature` on mismatch.

Reject any request that presents Bearer but no HMAC on `/v1/log/*`.
Reject Bearer only on `/v1/streams` (config endpoints don't need HMAC —
they're rare and audited via `last_used_at`).

### 3. `POST /v1/log/{stream_name}` — single leaf

Request body:

```json
{
  "tenant_seq": 918273,
  "idempotency_key": "uuid-or-vendor-id",
  "principal_id": "PRN_9F8E7D6C",
  "event_time": "2026-07-10T14:03:22.114Z",
  "payload_hash": "sha256:ab12...",
  "payload_bytes": null,
  "dims": {"input_hash":"sha256:...","output_hash":"sha256:..."},
  "meta": {"region":"eu-west","kind":"tool_call"}
}
```

Handler flow:

1. Look up `streams` row by `(tenant_id, stream_name)`. 404 if not found.
2. If `stream.principal_mode == 'per_leaf'`: require `principal_id` and
   verify an ACTIVE `delegations` row exists. Reject `delegation_inactive`
   (401) if missing or revoked.
   If `principal_mode == 'fixed'`: force `principal_id = stream.fixed_principal`
   regardless of body.
   If `'none'`: reject a body-provided `principal_id` (400).
3. Validate schema:
   - `tenant_seq` must be a positive integer.
   - `idempotency_key` present, non-empty, ≤ 255 chars.
   - `event_time` must parse as RFC3339 UTC.
   - `payload_hash` must match `^sha256:[0-9a-f]{64}$` or (for future) an
     allowed prefix (`sha256:`, `sha512:`, `blake3:`).
   - `dims` values must all be `sha256:`-prefixed.
   - `meta` schema-check: reject keys matching the PII denylist regex
     (`/^(name|email|phone|ssn|dob|password|address|first_name|last_name)$/i`)
     — this is a best-effort guard per canonical design §9.
   - `payload_bytes`: **must be null** unless this stream is registered
     with `preserve_at_witness=true` (Phase 2; Sprint 1 always rejects).
   - Stream-name lint: if the tenant is NOT `TEN_scruple`, reject any
     `stream_name` starting with `_scruple.` or `scruple.`.
4. Idempotency check: look up `log_leaves` by `(stream_id, idempotency_key)`.
   If found, return the previously-computed `{leaf_hash, chain_hash,
   pending_checkpoint_epoch}` with `duplicate: true` — **do NOT** rewrite.
5. Contiguity check: fetch `MAX(tenant_seq) FROM log_leaves WHERE stream_id=?`.
   Cases:
   - Body `tenant_seq == max+1`: normal. Set `meta.gap = false`.
   - Body `tenant_seq > max+1`: gap. Accept (per §5.2 gap policy), set
     `meta.gap = true` and `meta.gap_from = max+1`. Do NOT reject.
   - Body `tenant_seq <= max`: reject `seq_replay` (409). Vendors cannot
     rewind.
6. Compute `leaf_hash`:
   ```
   preimage = canonicalLeafV23({
     tenant_id, principal_id, stream_id, tenant_seq,
     event_time, payload_hash, dims
   })
   leaf_hash = sha256(preimage)
   ```
7. Compute `chain_hash = sha256(prev_chain_hash || leaf_hash)` where
   `prev_chain_hash` is the previous leaf's `chain_hash` on this stream
   (or 64 zeros for the first leaf).
8. Single INSERT into `log_leaves` — no Merkle work inline.
9. Determine `pending_checkpoint_epoch`: `floor((now - stream.created_at) /
   stream.checkpoint_secs) + 1`.
10. Response 200:
    ```json
    {
      "leaf": {
        "stream_id": "STR_1A2B3C4D",
        "tenant_seq": 918273,
        "leaf_hash": "sha256:...",
        "chain_hash": "sha256:...",
        "pending_checkpoint_epoch": 4412
      }
    }
    ```

### 4. `POST /v1/log/{stream_name}/batch`

Same shape but body is `{leaves: [<leaf>, ...]}` (max 1000). Server iterates
sequentially, applying the same contiguity + idempotency logic per leaf.
Response is an array of per-leaf results (mirrors input length; each entry
is either `{leaf: {...}}` or `{error: "...", tenant_seq: N}`). Partial
success is allowed and expected.

### 5. `POST /v1/streams` — create or update

Body:

```json
{
  "name": "gen.image.output",
  "checkpoint_secs": 300,
  "tsa_mode": "rfc3161",
  "tsa_url": "https://tsa.example.com/",
  "anchor_epoch_secs": 3600,
  "retention_days": 2555,
  "principal_mode": "per_leaf"
}
```

If stream exists: update (immutable fields = `name` and existing
`principal_mode` if it's already been used to write leaves). Otherwise
create with a new `stream_id`. Response echoes the full stream row.

Validate: `checkpoint_secs >= 60`, `anchor_epoch_secs >= checkpoint_secs`,
`tsa_mode` in the CHECK constraint. If `tsa_mode='rfc3161_qualified'`,
require `tsa_url` set to a URL on an internal allow-list (WO-11 procures
the qualified TSAs and populates the allow-list).

### 6. `GET /v1/streams` — list

Returns the tenant's streams with:

- Config columns
- `latest_leaf_seq`, `latest_leaf_received_at`
- `latest_checkpoint_epoch`, `latest_checkpoint_at`
- `latest_anchor_at`, `latest_anchor_id`

### 7. Rate limiting per tenant

- Per-tenant: default 500 req/s (batch counts as N req/s where N = batch
  size). Config on tenant row via optional `rate_limit_rps` column
  (schema addition; make it nullable so default applies).
- On breach: 429 with `Retry-After: 1` header.
- Global concurrency backpressure: if the ingest DB write queue depth > 500,
  return 503 `overloaded`.

### 8. Response envelope conventions

- Success: 200 with the payload above.
- Auth failure: 401 with `{error: "...", code: "invalid_signature" |
  "unknown_key" | "delegation_inactive"}`.
- Validation failure: 400 with `{error: "...", detail: {...field-level}}`.
- Idempotent replay: 200 with `duplicate: true` field.
- Sequence replay: 409 with `{error: "seq_replay", latest_seq: N}`.
- Rate limit: 429 with `Retry-After`.
- Overload: 503 with `Retry-After`.

## What NOT to build

- Do not accept `payload_bytes` on any stream in Sprint 1. Return 400 always.
- Do not implement `/v1/proof/*` here — those live in WO-09 (verifier
  reads them) and are scaffolded in WO-13 for the principal side.
- Do not add UPDATE / DELETE on `log_leaves`. Not even for admin.
- Do not initialize the DB conn per request — reuse the existing `conn()`
  singleton from `lib/db/sqlite`.
- Do not shell out to Python for canonicalization. Use the TypeScript
  `canonicalLeafV23` from WO-05 for the server-side path.
- Do not run Merkle assembly inline. Ingest is validate → hash → INSERT.
  All Merkle work is in WO-07.

## Deliverables

- Route files listed above.
- `lib/witness/ingest.ts` — helper module implementing the ingest flow
  (called by the route). Keeps route thin.
- `lib/witness/hmacMiddleware.ts` — reusable middleware for HMAC verification.
- `lib/witness/rateLimit.ts` — reusable per-tenant sliding window.
- Update `lib/db/sqlite.ts` (or equivalent) with type helpers for the new
  tables — mirror the pattern used for existing tables.
- Integration tests:
  - Happy path single-leaf ingest returns correct `leaf_hash`,
    `chain_hash`.
  - Batch with 1000 leaves succeeds.
  - Contiguity gap accepted with `meta.gap=true`.
  - Sequence replay rejected 409.
  - Idempotency replay returns 200 `duplicate: true`, DB row count
    unchanged.
  - Bad HMAC returns 401.
  - Clock skew > 300s returns 401.
  - Missing delegation on `per_leaf` stream returns 401 `delegation_inactive`.
  - Tenant-provided `_scruple.*` stream name from non-internal tenant
    returns 400.
  - `payload_bytes` present returns 400.
  - Rate limit trips at 500 req/s.

## Acceptance criteria

- [ ] All integration tests above pass.
- [ ] Ingest p99 < 15 ms measured on the Oracle box under 5k req/s for a
      stream with 100k pre-existing leaves.
- [ ] `conn().prepare("SELECT COUNT(*) FROM log_leaves WHERE stream_id=?").get(id)`
      after the tests matches the accepted-leaf count from test logs.
- [ ] `curl -X POST ...` from a test script demonstrates a full round-trip
      for a fresh stream + leaf.
- [ ] No route handler contains an UPDATE or DELETE against `log_leaves`,
      `checkpoints`, or `anchor_epochs` (grep-gated).

## Related

- Canonical design §6.2 (Ingestion API surface)
- Canonical design §14 (append-only invariant, rate-limit invariant)
- `docs/architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md` §5 (leaf schema),
  §4.0 (delegation validation)
- WO-05 — schema + canonical leaf module
- WO-07 — reads what this WO writes
- WO-08 — the C2PA daemon's first client
- WO-15 (Sprint 2) — SDK that hits these endpoints from the vendor side
