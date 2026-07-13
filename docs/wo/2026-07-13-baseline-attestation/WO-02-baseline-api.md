# WO-02 — Baseline API endpoints

**Phase:** 1 (Foundation)
**Depends on:** WO-01
**Blocks:** WO-03, WO-05
**Owner:** server
**Effort:** ~1.5 days

## Purpose

Ship the five baseline REST endpoints the SDK will call. All authenticated
via tenant Bearer key. Only submit + rebaseline mutate; the others are
read/verify.

## Deliverables

### Routes

Under `app/api/v1/tenants/[tenant]/baseline/`:

| Route | File | Purpose |
|---|---|---|
| `POST /api/v1/tenants/[tenant]/baseline` | `route.ts` | Submit initial (genesis) baseline. Rejects with 409 if tenant already has an active baseline. |
| `POST /api/v1/tenants/[tenant]/rebaseline` | `rebaseline/route.ts` | Submit new baseline; links to previous via `prev_baseline_hash`. Rejects with 400 if `prev_baseline_hash` in body doesn't match tenant's current. |
| `GET /api/v1/tenants/[tenant]/baseline/current` | `current/route.ts` | Return the tenant's currently-active baseline. |
| `GET /api/v1/tenants/[tenant]/baseline/history` | `history/route.ts` | Return the tenant's baseline chain, most recent first. Optional `?limit=` and `?before=<hash>` cursor. |
| `POST /api/v1/tenants/[tenant]/baseline/verify` | `verify/route.ts` | Given a candidate baseline hash, is it the tenant's current? Fast check for SDK self-verify before submitting witness calls. |

### Request/response shapes

**POST /baseline (submit genesis)**

```json
{
  "manifest": { ... canonicalized baseline manifest ... },
  "manifest_hash_hex": "<sha256 of canonicalize(manifest)>",
  "signer_pubkey_spki_sha256_hex": "<hex>",
  "attestation": { ... AttestationEnvelope or null ... },
  "submitted_at": "<RFC 3339>"
}
```

Response 200:
```json
{
  "baseline_id": 42,
  "baseline_hash": "<hex>",
  "activated_at": "<RFC 3339>",
  "witness_leaf_id": 12345
}
```

Response 409 if tenant already has an active baseline:
```json
{ "error": "tenant already has active baseline",
  "current_baseline_hash": "<hex>",
  "hint": "use /rebaseline to supersede" }
```

**POST /rebaseline** — same body shape plus:
```json
{
  ...
  "prev_baseline_hash": "<hex; MUST match tenant's current>",
  "reason": "<free-text; recorded in the audit chain>"
}
```

Response 200: same shape as /baseline. Response 400 on prev mismatch.

**GET /baseline/current** — 200 returns:
```json
{
  "baseline_hash": "<hex>",
  "activated_at": "<RFC 3339>",
  "attestation_provider": "amd-sev-snp" | "none" | ...,
  "signer_pubkey_spki_sha256_hex": "<hex>"
}
```
404 if tenant has no baseline yet.

**GET /baseline/history** — 200 returns array of `{ baseline_hash, prev_baseline_hash, activated_at, retired_at, reason }` items ordered `activated_at DESC`. Genesis's `prev_baseline_hash` is null.

**POST /baseline/verify** — body `{ "candidate_hash_hex": "<hex>" }`. Response `{ "matches_current": true|false, "current_baseline_hash": "<hex>" }`.

### Auth

Reuse the existing tenant Bearer auth middleware. `[tenant]` path segment must equal the tenant claimed by the bearer key; mismatch → 403.

### DAO layer

`lib/baseline/dao.ts`:

- `insertGenesis(tenant, manifest_hash, manifest_json, pubkey_hash, attestation_envelope): { baseline_id, activated_at }`
- `insertRebaseline(tenant, prev_hash, manifest_hash, manifest_json, pubkey_hash, attestation_envelope, reason): { baseline_id, activated_at }` (transactionally: verify prev matches current, insert new, update tenant_current_baseline, retire old)
- `getCurrent(tenant): BaselineRow | null`
- `getHistory(tenant, limit?, before?): BaselineRow[]`

## Acceptance criteria

- [ ] All five routes return correct status codes for the documented cases.
- [ ] `/baseline` on a tenant with existing active → 409; `/rebaseline` on a tenant with no baseline yet → 404; `/rebaseline` with wrong prev → 400.
- [ ] Transactional integrity: a failed `insertRebaseline` (e.g., prev mismatch caught mid-transaction) leaves `tenant_current_baseline` unchanged.
- [ ] Baseline leaves are recorded in the audit log with `leaf_kind = 'baseline'` or equivalent (see WO-03 for the schema tie-in).
- [ ] Manifest bytes stored verbatim (byte-identical round-trip; SHA-256 recompute matches `baseline_hash`).
- [ ] Unit tests for the DAO; integration tests for each route (fastify/next-test or bare HTTP).

## Notes

- The `witness_leaf_id` on the baseline row ties the baseline to its underlying audit leaf. That leaf must be inserted first (WO-03 defines the leaf schema for baseline leaves); the DAO transaction inserts the leaf, gets the leaf id, then inserts the baseline row referring to it.
- Do NOT verify the attestation envelope in this WO — verification is WO-03 (freshness) + WO-04 (SEV-SNP) etc. Here, just store what was submitted.
- Ratelimit: none for v1. Add per-tenant limit later if abuse is observed.

## Landing

One commit: `feat(baseline): API endpoints — submit / rebaseline / current / history / verify`. Include DAO, routes, integration tests.
