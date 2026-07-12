-- Migration 030 — Scruple Log (Continuous Audit API) schema.
--
-- Underpins the multi-tenant witness service ("the tunnel") that
-- backs both:
--   1. C2PA Conformance Program L2 audit-log requirement — the C2PA
--      signer emits a leaf per sign event on stream 'scruple.c2pa.sign'.
--   2. Independent AI Witnessing Rider clauses §3–§5 — inclusion
--      proofs, consistency proofs, principal direct access, zero-content
--      posture.
--
-- Design: docs/architecture/CANONICAL_SCRUPLE_WITNESSING_L2.md §6.
-- Leaf spec: docs/architecture/SCRUPLE_CONTINUOUS_AUDIT_API_DESIGN.md §5.1.
-- WO: docs/wo/2026-07-12-witnessing-l2/WO-05-audit-api-schema.md.
--
-- Bytes are stored as lowercase hex TEXT for cross-language parity —
-- Python <-> TypeScript agree byte-for-byte on hex encoding, which is
-- what canonical leaf hashing requires.
--
-- Append-only invariant: no code path is permitted to UPDATE or DELETE
-- rows in log_leaves, log_checkpoints, or anchor_epochs. Enforced by
-- convention in this migration; a later hardening WO adds triggers.

CREATE TABLE tenants (
  tenant_id       TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL,
  hmac_secret_enc TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  is_internal     INTEGER NOT NULL DEFAULT 0,
  rate_limit_rps  INTEGER,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (status IN ('active','suspended','revoked'))
);

CREATE TABLE principals (
  principal_id    TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  read_key_hash   TEXT NOT NULL,
  user_id         TEXT,
  contact_email   TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_principals_user_id ON principals(user_id);

CREATE TABLE delegations (
  delegation_id   TEXT PRIMARY KEY,
  principal_id    TEXT NOT NULL REFERENCES principals(principal_id),
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
  scope_streams   TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at      TEXT,
  UNIQUE (principal_id, tenant_id),
  CHECK (status IN ('active','revoked'))
);
CREATE INDEX idx_delegations_tenant_status ON delegations(tenant_id, status);

CREATE TABLE streams (
  stream_id         TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL REFERENCES tenants(tenant_id),
  name              TEXT NOT NULL,
  schema_hint       TEXT,
  checkpoint_secs   INTEGER NOT NULL DEFAULT 300,
  tsa_mode          TEXT NOT NULL DEFAULT 'none',
  tsa_url           TEXT,
  anchor_epoch_secs INTEGER NOT NULL DEFAULT 3600,
  retention_days    INTEGER NOT NULL DEFAULT 2555,
  principal_mode    TEXT NOT NULL DEFAULT 'none',
  fixed_principal   TEXT REFERENCES principals(principal_id),
  escalation_policy TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (tenant_id, name),
  CHECK (tsa_mode IN ('none','rfc3161','rfc3161_qualified')),
  CHECK (principal_mode IN ('none','fixed','per_leaf')),
  CHECK (checkpoint_secs >= 60),
  CHECK (anchor_epoch_secs >= checkpoint_secs)
);
CREATE INDEX idx_streams_tenant ON streams(tenant_id);

CREATE TABLE log_leaves (
  leaf_seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  stream_id       TEXT NOT NULL REFERENCES streams(stream_id),
  principal_id    TEXT REFERENCES principals(principal_id),
  tenant_seq      INTEGER NOT NULL,
  leaf_hash       TEXT NOT NULL,
  prev_chain_hash TEXT NOT NULL,
  chain_hash      TEXT NOT NULL,
  received_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_time      TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash    TEXT NOT NULL,
  dims_json       TEXT,
  meta_json       TEXT,
  escalated       INTEGER NOT NULL DEFAULT 0,
  UNIQUE (stream_id, tenant_seq),
  UNIQUE (stream_id, idempotency_key)
);
CREATE INDEX idx_leaves_stream_seq ON log_leaves(stream_id, tenant_seq);
CREATE INDEX idx_leaves_stream_recv ON log_leaves(stream_id, received_at);
CREATE INDEX idx_leaves_principal ON log_leaves(principal_id);

CREATE TABLE log_checkpoints (
  checkpoint_id   TEXT PRIMARY KEY,
  stream_id       TEXT NOT NULL REFERENCES streams(stream_id),
  epoch_index     INTEGER NOT NULL,
  first_seq       INTEGER NOT NULL,
  last_seq        INTEGER NOT NULL,
  merkle_root     TEXT NOT NULL,
  prev_checkpoint TEXT REFERENCES log_checkpoints(checkpoint_id),
  witness_sig     TEXT NOT NULL,
  witness_key_id  TEXT NOT NULL,
  tsa_token_b64   TEXT,
  is_heartbeat    INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  anchored_in     TEXT,
  UNIQUE (stream_id, epoch_index)
);
CREATE INDEX idx_log_checkpoints_stream_epoch ON log_checkpoints(stream_id, epoch_index);
CREATE INDEX idx_log_checkpoints_unanchored ON log_checkpoints(anchored_in) WHERE anchored_in IS NULL;

CREATE TABLE anchor_epochs (
  anchor_id        TEXT PRIMARY KEY,
  super_root       TEXT NOT NULL,
  checkpoint_count INTEGER NOT NULL,
  rvn_txid         TEXT,
  ipfs_cid         TEXT,
  arweave_id       TEXT,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Seed: Scruple itself as internal Tenant #0. The 'internal' sentinel
-- values in api_key_hash and hmac_secret_enc are placeholders — real
-- credentials are provisioned via deploy/scripts/provision-c2pa-tenant.sh
-- (WO-08 output) which UPDATEs this row.
INSERT INTO tenants (tenant_id, name, api_key_hash, hmac_secret_enc, is_internal)
VALUES ('TEN_scruple', 'Scruple (internal)', 'internal', 'internal', 1);
