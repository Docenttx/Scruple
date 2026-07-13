# WO-03 — Ingest baseline reference + freshness window

**Phase:** 1 (Foundation)
**Depends on:** WO-01, WO-02
**Blocks:** WO-04, WO-05, WO-06
**Owner:** server
**Effort:** ~1.5 days

## Purpose

Wire the existing witness ingest paths so every leaf carries a
`baseline_hash` reference AND — if the tenant's baseline declares
`attestation.provider != 'none'` — a valid `platform_attestation`
envelope with the freshness window enforced. Also add the `leaf_kind`
column so baseline leaves are distinguishable from workflow leaves.

## Deliverables

### 1. Migration — leaf schema extensions

`lib/db/migrations/024_leaf_baseline_ref.sql`:

- Add columns to `iterations` (and equivalent tables in the witness log):
  - `baseline_hash` TEXT NULL (hex; NULL only for pre-baseline legacy rows)
  - `platform_attestation_json` TEXT NULL (the envelope, verbatim)
  - `platform_attestation_verified` INTEGER NULL (0 = not verified, 1 = server-verified, 2 = passthrough stored)
  - `leaf_kind` TEXT NOT NULL DEFAULT 'workflow' (CHECK IN ('workflow', 'baseline', 'rebaseline', 'abort'))
- Index on `(tenant_id, baseline_hash)` for baseline-scoped receipt lookups.

### 2. Ingest changes

Update every existing witness ingest route to:

1. Require an `X-Baseline-Hash` header on incoming requests. Reject with **409** if:
   - header missing, or
   - header value doesn't match tenant's current baseline (per `GET /baseline/current`).
   - The 409 body includes the current baseline hash + hint: "re-baseline via /rebaseline before submitting further leaves."
2. If the tenant's baseline declares `attestation.provider != 'none'`:
   - Require the request body include a `platform_attestation` envelope.
   - Validate envelope shape (via `envelopeSchemaValidator` from WO-01).
   - Enforce freshness: reject with **400** if `attestation_time` older than the tenant's window (default 15 min at time of `receive_time`).
   - Enforce nonce binding: compute `sha256(canonical_leaf_preimage_without_attestation)` and compare to `envelope.nonce`; reject with **400** on mismatch.
   - DO NOT verify the attestation report itself here — that's WO-04+ per attestation type. Set `platform_attestation_verified = 0` for now; WO-04 flips it to 1 or 2 once dispatch is wired.
3. Store `baseline_hash`, `platform_attestation_json` on the leaf row.

Routes to update (all existing witness ingest surfaces):
- `app/api/scruple/witness/adobe/route.ts`
- `app/api/scruple/witness/photoshop/route.ts`
- `app/api/witness/cad/route.ts`
- `app/api/apps/kohya/witness/route.ts`
- `app/api/v1/log/[stream_name]/route.ts`
- `app/api/v1/log/[stream_name]/batch/route.ts`

### 3. Config: freshness window per tenant

Add to tenant config (or a new `tenant_config` row):
- `attestation_freshness_max_seconds` INTEGER DEFAULT 900 (15 min)

Read this in the ingest handlers.

### 4. Shared helper

`lib/baseline/ingest_check.ts`:

- `enforceBaselineRef(tenant_id, header): BaselineOrReject`
- `enforceAttestation(baseline, envelope, leaf_preimage, freshness_max_sec): AttestationOrReject`

Both return `{ ok: true, ... }` or `{ ok: false, status, body }`. Ingest routes call these before doing their own work.

## Acceptance criteria

- [ ] Migration 024 applied; existing rows keep `baseline_hash = NULL` and `leaf_kind = 'workflow'` (backwards-compat safe).
- [ ] Every witness ingest route:
  - Returns 409 when `X-Baseline-Hash` is missing or wrong.
  - Returns 400 when `platform_attestation` is missing but required by tenant's baseline.
  - Returns 400 when `attestation_time` is outside the freshness window.
  - Returns 400 when nonce doesn't match `sha256(leaf_preimage_without_attestation)`.
  - Returns 200 and stores the leaf with the baseline_hash + attestation envelope on a valid call.
- [ ] Integration tests cover each rejection branch.
- [ ] E2E smoke: create a fake baseline (tenant with `attestation.provider: none`), submit a witness call with the correct `X-Baseline-Hash`, confirm 200 + row inserted with `baseline_hash` populated and `platform_attestation_verified = 0` (since no attestation required).

## Notes

- Nonce computation MUST be over the leaf preimage EXCLUDING the platform_attestation envelope (chicken-and-egg otherwise). Document this clearly in the helper.
- Do NOT change existing leaf hashing / canonicalization; just add fields.
- Existing legacy leaves without baseline_hash remain valid for retrospective read; only NEW leaves post-migration are enforced.

## Landing

One commit: `feat(baseline): ingest enforces baseline ref + attestation envelope`. Migration + shared helper + all ingest route updates + tests.
