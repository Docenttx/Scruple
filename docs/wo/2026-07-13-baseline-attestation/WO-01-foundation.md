# WO-01 — Foundation: data model + envelope schema + verifier lib skeleton

**Phase:** 1 (Foundation)
**Depends on:** none (first WO)
**Blocks:** WO-02, WO-03, all subsequent WOs
**Owner:** server + shared lib
**Effort:** ~2 days

## Purpose

Establish the three pieces of infrastructure every subsequent WO depends on:
the DB tables that hold baselines, the JSON envelope every leaf uses to
carry a `platform_attestation`, and the shared-library skeleton whose
plugins will be imported by both the server API (verification at ingest)
and the reference verifier CLI (independent re-verification downstream).

## Deliverables

### 1. DB migration — baselines schema

`lib/db/migrations/023_baselines.sql`:

- `baselines` table
  - `id` INTEGER PRIMARY KEY
  - `tenant_id` TEXT NOT NULL
  - `baseline_hash` TEXT NOT NULL UNIQUE (hex SHA-256 of the canonical manifest)
  - `prev_baseline_hash` TEXT NULL (hex; NULL for genesis)
  - `manifest_json` TEXT NOT NULL (the canonicalized baseline manifest)
  - `attestation_provider` TEXT NOT NULL (`'none'` or the declared type)
  - `attestation_envelope_json` TEXT NULL (the baseline-time attestation, if declared)
  - `signer_pubkey_spki_sha256_hex` TEXT NOT NULL (integrator's baseline-bound signing key)
  - `submitted_at` TEXT NOT NULL (RFC 3339)
  - `activated_at` TEXT NOT NULL (RFC 3339; when this baseline became current)
  - `retired_at` TEXT NULL (set when superseded by a re-baseline)
  - `witness_leaf_id` INTEGER NULL (FK to `iterations` or equivalent; the baseline leaf itself)

- `tenant_current_baseline` table
  - `tenant_id` TEXT PRIMARY KEY
  - `baseline_id` INTEGER NOT NULL (FK to `baselines.id`)
  - Updated atomically on baseline / rebaseline

- Indices: `(tenant_id, activated_at DESC)` on `baselines`

### 2. Envelope schema

`packages/scruple-attestation-verifiers/src/envelope.ts`:

```typescript
export interface AttestationEnvelope {
  attestation_type:
    | 'amd-sev-snp'
    | 'intel-tdx'
    | 'aws-nitro-enclave'
    | 'gcp-confidential-space'
    | 'azure-attestation-service'
    | 'nvidia-h100-cc'
    | 'tpm-2.0-quote'
    | 'none'
    | string;  // any other string = passthrough, verifier_reference required
  attestation_report: string;    // base64
  certificate_chain: string[];   // PEM
  nonce: string;                 // hex, MUST equal sha256(leaf_preimage)
  attestation_time: string;      // RFC 3339
  verifier_reference?: string;   // required for passthrough types
}

export function canonicalizeEnvelope(e: AttestationEnvelope): string;
export function envelopeSchemaValidator(e: unknown): AttestationEnvelope;  // throws on invalid
export function isBuiltInType(t: string): boolean;
export function isPassthroughType(t: string): boolean;
```

Include a JSON Schema (`envelope.schema.json`) for cross-language validation.

### 3. Shared verifier library skeleton

New package at `packages/scruple-attestation-verifiers/`:

```
packages/scruple-attestation-verifiers/
├── package.json       (name: "@scruple/attestation-verifiers", type: module)
├── tsconfig.json
├── src/
│   ├── envelope.ts    (schemas + validators, above)
│   ├── dispatch.ts    (routes envelope → verifier plugin by attestation_type)
│   ├── verifier.ts    (VerifierPlugin interface + VerifyResult type)
│   ├── plugins/       (empty; populated in WO-04+)
│   │   └── .gitkeep
│   └── index.ts       (public API)
└── test/
    └── envelope.test.ts
```

`VerifierPlugin` interface:

```typescript
export interface VerifyResult {
  ok: boolean;
  provider: string;
  cvm_measurement_hex?: string;
  gpu_id?: string;
  driver_version?: string;
  chip_id?: string;
  error?: string;
  benign_codes?: string[];  // e.g. untrusted-CA for dev
}

export interface VerifierPlugin {
  attestation_type: string;
  verify(env: AttestationEnvelope, expected_nonce_hex: string,
         freshness_max_seconds: number): Promise<VerifyResult>;
}
```

`dispatch.ts` maps `attestation_type` → plugin. On unknown built-in type,
throws. On passthrough (unknown + `verifier_reference` present), returns a
"passthrough — not verified server-side" `VerifyResult`.

## Acceptance criteria

- [ ] Migration 023 applied cleanly; `SELECT * FROM baselines LIMIT 1` returns empty; `INSERT ... SELECT` round-trip works.
- [ ] `packages/scruple-attestation-verifiers/` compiles with `tsc --noEmit`.
- [ ] `envelope.test.ts` passes: valid envelope validates, malformed envelope throws with clear error, `canonicalizeEnvelope` produces byte-stable output for same input.
- [ ] Dispatch returns an "unknown built-in type" error for a known-invalid type; returns a "passthrough" result for an unknown type with `verifier_reference` set.
- [ ] No production code paths import this package yet (that lands in WO-03).

## Notes

- Match the existing canonical-JSON discipline (`lib/witness/canonicalLeafV23.ts`): sorted keys, no whitespace, empty-string defaults for absent optional fields.
- Keep the plugin interface synchronous-return-friendly where possible; some (NVIDIA JWT verify) will call out to Node crypto but can stay in-process.
- Do NOT add plugin implementations here; that's WO-04+.

## Landing

One commit: `feat(baseline): foundation — data model + envelope + verifier lib skeleton`. Include the migration, package skeleton, and tests. Tag the migration in `lib/db/migrations/HEAD.txt` (or wherever the head marker lives).
