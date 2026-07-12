# WO-05 — Audit API schema (migration 022) + canonical leaf v23 + parity tests

**Sprint:** 1
**Estimate:** 10 owner-hours
**Blocking:** none — can start immediately, in parallel with WO-01/WO-03
**Blocks:** WO-06 (ingest needs schema), WO-07 (checkpoints need leaves table),
WO-08 (C2PA emits into these tables), WO-09 (verifier CLI needs leaf spec)

## Goal

Land the SQLite schema and the canonical leaf v23 module that underpin the
Continuous Audit API. After this WO, the tables exist, `canonicalLeafV23` is
usable from both server code and (eventually) the SDK, and a parity test
proves that server-side and SDK-side hashing produce byte-identical outputs
for the same input.

## What to build

### 1. Migration `022_scruple_log.sql`

Schema per canonical design §6.1 and the Continuous Audit design doc §4.1.
Adapt Postgres shapes to SQLite (TEXT for TIMESTAMPTZ, TEXT for BYTEA storing
hex-encoded bytes, BLOB where more efficient).

```sql
-- 022_scruple_log.sql
BEGIN;

CREATE TABLE tenants (
  tenant_id       TEXT PRIMARY KEY,           -- 'TEN_' + 8 hex
  name            TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL,              -- sha256(api_key) hex
  hmac_secret_enc TEXT NOT NULL,              -- AES-GCM ciphertext (KEK in Vault, later)
  status          TEXT NOT NULL DEFAULT 'active',
  is_internal     INTEGER NOT NULL DEFAULT 0, -- Scruple itself = 1
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE principals (
  principal_id    TEXT PRIMARY KEY,           -- 'PRN_' + 8 hex
  name            TEXT NOT NULL,
  read_key_hash   TEXT NOT NULL,              -- sha256(read_key) hex
  user_id         TEXT,                       -- FK to users.id when the principal
                                              -- is a Scruple end-user (nullable for
                                              -- enterprise principals not on Scruple)
  contact_email   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_principals_user_id ON principals(user_id);

CREATE TABLE delegations (
  delegation_id   TEXT PRIMARY KEY,           -- 'DLG_' + 8 hex
  principal_id    TEXT NOT NULL REFERENCES principals,
  tenant_id       TEXT NOT NULL REFERENCES tenants,
  scope_streams   TEXT,                       -- JSON array; NULL = all streams
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at      TEXT,
  UNIQUE (principal_id, tenant_id)
);
CREATE INDEX idx_delegations_active ON delegations(tenant_id, status);

CREATE TABLE streams (
  stream_id         TEXT PRIMARY KEY,         -- 'STR_' + 8 hex
  tenant_id         TEXT NOT NULL REFERENCES tenants,
  name              TEXT NOT NULL,
  schema_hint       TEXT,                     -- JSON
  checkpoint_secs   INTEGER NOT NULL DEFAULT 300,
  tsa_mode          TEXT NOT NULL DEFAULT 'none',
  tsa_url           TEXT,
  anchor_epoch_secs INTEGER NOT NULL DEFAULT 3600,
  retention_days    INTEGER NOT NULL DEFAULT 2555,
  principal_mode    TEXT NOT NULL DEFAULT 'none',
  fixed_principal   TEXT REFERENCES principals,
  escalation_policy TEXT,                     -- JSON; NULL = off
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, name),
  CHECK (tsa_mode IN ('none','rfc3161','rfc3161_qualified')),
  CHECK (principal_mode IN ('none','fixed','per_leaf'))
);
CREATE INDEX idx_streams_tenant ON streams(tenant_id);

CREATE TABLE log_leaves (
  leaf_seq        INTEGER PRIMARY KEY AUTOINCREMENT, -- global monotone id
  stream_id       TEXT NOT NULL REFERENCES streams,
  principal_id    TEXT REFERENCES principals,
  tenant_seq      INTEGER NOT NULL,
  leaf_hash       TEXT NOT NULL,              -- sha256 hex, 64 chars
  prev_chain_hash TEXT NOT NULL,              -- 64 chars, '0'*64 for first leaf
  chain_hash      TEXT NOT NULL,              -- 64 chars
  received_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_time      TEXT NOT NULL,              -- vendor-supplied
  idempotency_key TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  dims_json       TEXT,                       -- canonical JSON of dims
  meta_json       TEXT,                       -- non-sensitive envelope only
  escalated       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (stream_id, tenant_seq),
  UNIQUE (stream_id, idempotency_key)
);
CREATE INDEX idx_leaves_stream_seq ON log_leaves(stream_id, tenant_seq);
CREATE INDEX idx_leaves_stream_recv ON log_leaves(stream_id, received_at);
CREATE INDEX idx_leaves_principal ON log_leaves(principal_id) WHERE principal_id IS NOT NULL;

CREATE TABLE checkpoints (
  checkpoint_id   TEXT PRIMARY KEY,           -- 'CKP_' + 8 hex of sha256(merkle_root)
  stream_id       TEXT NOT NULL REFERENCES streams,
  epoch_index     INTEGER NOT NULL,
  first_seq       INTEGER NOT NULL,
  last_seq        INTEGER NOT NULL,
  merkle_root     TEXT NOT NULL,              -- 64 hex
  prev_checkpoint TEXT REFERENCES checkpoints,
  witness_sig     TEXT NOT NULL,              -- Ed25519 (or ECDSA) sig, hex
  witness_key_id  TEXT NOT NULL,              -- OCID / key handle used
  tsa_token_b64   TEXT,                       -- base64 of DER TimeStampToken
  is_heartbeat    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  anchored_in     TEXT,                       -- FK to anchor_epochs.anchor_id
  UNIQUE (stream_id, epoch_index)
);
CREATE INDEX idx_checkpoints_unanchored ON checkpoints(anchored_in) WHERE anchored_in IS NULL;

CREATE TABLE anchor_epochs (
  anchor_id        TEXT PRIMARY KEY,          -- 'ANC_' + 8 hex of sha256(super_root)
  super_root       TEXT NOT NULL,             -- 64 hex
  checkpoint_count INTEGER NOT NULL,
  rvn_txid         TEXT,
  ipfs_cid         TEXT,
  arweave_id       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Seed: Scruple as internal Tenant #0
INSERT INTO tenants (tenant_id, name, api_key_hash, hmac_secret_enc, is_internal)
VALUES ('TEN_scruple', 'Scruple (internal)', 'internal', 'internal', 1);

COMMIT;
```

Follow the existing migration numbering convention (`migrations/022_*.sql`).
Wire into whichever runner the project uses today.

### 2. Module `lib/witness/canonicalLeafV23.ts`

Canonical leaf preimage builder + SHA-256 hasher. **Same discipline as
`canonicalRecordV22`:** fixed field order, compact JSON, empty-string
defaults, no whitespace, deterministic key ordering.

```typescript
// lib/witness/canonicalLeafV23.ts

// FIELD ORDER IS PART OF THE CONTRACT. Any change requires:
//   1. Version bump to v24.
//   2. Verifier CLI accepts both.
//   3. Audit script fallback chain updated.
// Never mutate this list in place.
const LEAF_V23_FIELD_ORDER = [
  'tenant_id',
  'principal_id',
  'stream_id',
  'tenant_seq',
  'event_time',
  'payload_hash',
  'dims',
] as const;

export interface CanonicalLeafV23 {
  tenant_id: string;
  principal_id: string;      // '' when absent
  stream_id: string;
  tenant_seq: number;
  event_time: string;         // RFC3339 UTC
  payload_hash: string;
  dims: Record<string, string>; // sorted keys, empty {} allowed
}

export function canonicalLeafV23(input: Partial<CanonicalLeafV23>): string {
  const out: Record<string, unknown> = {};
  for (const k of LEAF_V23_FIELD_ORDER) {
    if (k === 'dims') {
      const d = input.dims ?? {};
      // Sort dims keys to guarantee determinism.
      out.dims = Object.fromEntries(Object.keys(d).sort().map(k => [k, d[k]]));
    } else {
      out[k] = input[k] ?? (k === 'tenant_seq' ? 0 : '');
    }
  }
  // JSON.stringify with no spacing.
  return JSON.stringify(out);
}

export function leafHashV23(input: Partial<CanonicalLeafV23>): string {
  const preimage = canonicalLeafV23(input);
  return sha256Hex(preimage);
}
```

Ship a parallel Python module `services/witness/canonical_leaf_v23.py` with
byte-identical output — this is what the C2PA signer daemon and future
Python SDKs use.

### 3. Parity tests

Cross-language parity is a **unit-test gated invariant** — the design doc
calls this out multiple times and it is the load-bearing contract for the
whole verifier story.

Test vectors in `test/fixtures/canonical-leaf-v23-vectors.json` — 20 vectors
covering:

- Empty dims + all fields present.
- Absent principal_id.
- Unicode payload_hash / meta values (BMP + astral).
- Very large tenant_seq (near INT64 max).
- Dims with keys inserted out-of-order — result must match sorted-key
  hash.

Two tests:

- `test/witness/canonical-leaf-v23.test.ts` — feed each vector to
  TypeScript `leafHashV23`, assert output matches the expected hash in
  the vector file.
- `services/witness/tests/test_canonical_leaf_v23.py` — feed each vector
  to Python `canonical_leaf_v23.leaf_hash_v23`, assert same expected hash.

Both must reference the SAME fixtures file. CI fails if either diverges
from expected OR from each other.

### 4. Helper module `lib/witness/streamIds.ts`

Generate IDs per the design doc format:

```typescript
export function newTenantId(name: string): string {
  return 'TEN_' + sha256Hex(name + Date.now()).slice(0, 8);
}
// analogous newPrincipalId, newDelegationId, newStreamId, newCheckpointId, newAnchorId
```

### 5. Reserved stream registration

Reserve stream names for internal use:

- `_scruple.delegations` — grants/revokes (§4.0 rule 2)
- `_scruple.escalations` — Phase 2 escalation decisions
- `scruple.c2pa.sign` — C2PA sign events (this build)

Add a lint check in ingest (WO-06) that rejects tenant-provided stream
names starting with `_scruple.` or `scruple.` when the tenant is not
`TEN_scruple`.

## What NOT to build

- No API endpoints in this WO — those are WO-06.
- No writes to any of these tables from application code — those come
  in WO-06 and WO-08.
- Do not add UPDATE or DELETE code paths on `log_leaves`, `checkpoints`,
  or `anchor_epochs`. Append-only invariant enforced by convention now,
  enforced by triggers in a later hardening WO.
- Do not migrate any existing data. The old ad-hoc audit sources are
  Sprint 3 evidence-packaging work.

## Deliverables

- `migrations/022_scruple_log.sql`
- `lib/witness/canonicalLeafV23.ts`
- `services/witness/canonical_leaf_v23.py`
- `test/fixtures/canonical-leaf-v23-vectors.json` (20 vectors + expected
  hashes; generate expected hashes by running the TS implementation and
  freezing the output — the vectors ARE the contract)
- `test/witness/canonical-leaf-v23.test.ts`
- `services/witness/tests/test_canonical_leaf_v23.py`
- `lib/witness/streamIds.ts`
- Optional: Node script `scripts/seed-c2pa-stream.mjs` that seeds the
  `scruple.c2pa.sign` stream row against tenant `TEN_scruple`
  (idempotent; safe to re-run).

## Acceptance criteria

- [ ] Migration applies cleanly on a fresh DB and on the current dev DB
      (no conflicts with existing tables).
- [ ] All 20 parity-vector tests pass in TypeScript.
- [ ] All 20 parity-vector tests pass in Python producing bit-identical
      hashes to the TypeScript run.
- [ ] Attempting to insert a `log_leaves` row with duplicate
      `(stream_id, tenant_seq)` fails.
- [ ] Attempting to insert a `log_leaves` row with duplicate
      `(stream_id, idempotency_key)` fails.
- [ ] The seeded `TEN_scruple` tenant exists; the seed script for the
      `scruple.c2pa.sign` stream row succeeds and is idempotent.

## Related

- Canonical design §6 (Continuous Audit API)
- Canonical design §14 (non-compaction discipline — parity invariant)
- `docs/architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md` §5.1 (leaf schema)
- WO-06 — ingest API consumes this schema + parity function
- WO-07 — checkpoint scheduler reads `log_leaves`, writes `checkpoints`
- WO-08 — C2PA daemon emits leaves via ingest, indirectly writes here
- WO-09 — verifier CLI re-derives leaf hashes using the same canonicalization
