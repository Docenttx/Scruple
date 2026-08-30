-- Migration 041 — capture components: identity, key-schedule state, and
-- the counter accounting that makes silence and suppression visible.
--
-- H-4, docs/canon/H4-DUKPT-CAPTURE-COMPONENT.md §4. The two things
-- L2_AS_THE_VENDOR_FLOOR.md names as missing are both here:
--
--   Missing 1 — the capture component as a shipped, MEASURED artifact.
--     `build_measurement` is the analogue of a terminal's firmware version
--     riding in the transaction. Because we publish the component, a leaf
--     claiming a build we never shipped is detectable at ingest, which is
--     the first time P1 is checkable rather than merely attested.
--
--   Missing 2 — reconciliation. Nothing in the estate noticed when a
--     vendor STOPPED witnessing. Kohya is the proof: the pod hook no-ops
--     if an env var is absent, and a capture path gone dark produced the
--     same observable as a quiet afternoon. `last_verified_counter`,
--     `component_counter_gaps` and `last_seen_at` are the settlement half
--     that never existed.
--
-- WHY GAPS DO NOT REJECT. §4.2 is explicit and the reason is worth keeping
-- next to the schema: receiving n = last + 4 means three events were
-- produced and not delivered. The leaf still verifies — the server
-- ratchets through — and the gap is recorded as a first-class fact. If a
-- gap invalidated the surrounding leaves, suppressing one event would
-- become a way to attack the vendor's whole record. Hence a gaps table
-- rather than a rejection.
--
-- Style follows 032/039: TEXT ISO-8601 timestamps via datetime('now'),
-- tenant_id as a bare TEXT column (as in `baselines`) rather than a
-- foreign key to users, CHECK constraints on the small closed vocabularies.

CREATE TABLE IF NOT EXISTS components (
  -- UUIDv4 assigned at instance creation (§4.1). The salt in
  -- IK = HKDF(BDK, salt=component_id, ...), so it is key material input,
  -- not merely a label: two components can never share one.
  component_id                   TEXT PRIMARY KEY,

  -- The vendor. Matches `baselines.tenant_id` / `api_keys.user_id`.
  tenant_id                      TEXT NOT NULL,
  label                          TEXT,

  status                         TEXT NOT NULL DEFAULT 'pending'
                                   CHECK (status IN ('pending', 'active', 'retired')),

  -- 'sha256:...' of the image we published. NULL until the component
  -- provisions and declares it. §4.3 states the honest limit in the spec
  -- rather than leaving it to be discovered: a MODIFIED build can claim
  -- any measurement string. What it cannot do is produce a valid MAC
  -- without the IK — which is why the key and the measurement are one
  -- piece of work.
  build_measurement              TEXT,

  -- §4.3 / H-5. 'verified' means the IK was sealed to an attested
  -- measurement, so a modified build could not unseal it. 'passthrough'
  -- means the IK is software-protected and the binding is assertion.
  -- Both are compliant; the receipt says which. NULL = no attestation
  -- was supplied, which is honest absence and not a third tier.
  attestation_provider           TEXT NOT NULL DEFAULT 'none',
  attestation_quote_ref          TEXT,
  attestation_status             TEXT
                                   CHECK (attestation_status IN ('verified', 'passthrough')),

  -- Highest counter whose MAC verified. NULL = nothing has ever verified,
  -- which is distinct from 0 (event zero verified). The strict-increase
  -- rule in §4.2 compares against this, so conflating the two would let
  -- event 0 be replayed exactly once.
  last_verified_counter          INTEGER,
  last_verified_at               TEXT,

  -- Cached chain-key state: chain_key_hex holds K_{chain_key_counter}.
  -- A CACHE ONLY. The server holds the BDK and can re-derive any IK and
  -- ratchet to any counter from scratch; dropping these two columns costs
  -- CPU and loses nothing. Kept separate from last_verified_counter so
  -- the cache can be invalidated without rewriting verification history.
  --
  -- Custody note: while the BDK sits in an env var this cache is no
  -- weaker than the BDK beside it. Once the BDK moves into the HSM it
  -- becomes the weaker link — a database read would yield forward MAC
  -- forgery for every cached component — which is why
  -- SCRUPLE_RATCHET_CACHE_CHAIN_KEY=0 disables it and derivation falls
  -- back to the HSM path.
  chain_key_counter              INTEGER,
  chain_key_hex                  TEXT,

  -- Which BDK these derivations were made under (a truncated hash, never
  -- the key). A rotated or mistyped BDK otherwise presents as every
  -- component in the estate suddenly MACing wrongly, with nothing to say
  -- why.
  bdk_fingerprint                TEXT,

  -- Reconciliation. §4.2: no leaf for longer than the heartbeat window and
  -- the component is silent. Silence is the signal Kohya's design made
  -- invisible. The window is per-component because §9 records it as a
  -- tenant-visible parameter with a real tradeoff — short windows make
  -- silence a fast signal and make ordinary idleness noisy.
  last_seen_at                   TEXT,
  heartbeat_window_seconds       INTEGER NOT NULL DEFAULT 900,

  -- §4.4 injection. Stored as sha256(token) for the same reason api_keys
  -- stores sha256(key): the plaintext is shown once and never persisted.
  provisioning_token_hash        TEXT UNIQUE,
  provisioning_token_expires_at  TEXT,
  provisioning_token_consumed_at TEXT,
  provisioned_at                 TEXT,

  created_at                     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_components_tenant_status
  ON components(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_components_token
  ON components(provisioning_token_hash)
  WHERE provisioning_token_consumed_at IS NULL;

-- Silence sweep: "which active components have not been seen lately".
CREATE INDEX IF NOT EXISTS idx_components_last_seen
  ON components(status, last_seen_at);


-- Every counter that verified, so a duplicate is rejected on a stored fact
-- rather than on an inference from the high-water mark. §5 requires the
-- server to drop a genuine retry "idempotently on (component_id, counter)";
-- the PRIMARY KEY is that idempotence.
CREATE TABLE IF NOT EXISTS component_events (
  component_id   TEXT NOT NULL REFERENCES components(component_id),
  counter        INTEGER NOT NULL,
  mac            TEXT NOT NULL,
  preimage_sha256 TEXT NOT NULL,
  -- What the leaf CLAIMED it was built by, which may differ from the
  -- component's provisioned measurement — a component whose build changed
  -- mid-life is a fact worth having per event, not just per component.
  build_measurement TEXT,
  verified_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (component_id, counter)
);


-- Gaps, as first-class facts. A row here says: counters
-- [from_counter+1 .. to_counter-1] were produced by the component and
-- never arrived. from_counter is NULL when the gap precedes the
-- component's first ever verified event.
CREATE TABLE IF NOT EXISTS component_counter_gaps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id   TEXT NOT NULL REFERENCES components(component_id),
  from_counter   INTEGER,
  to_counter     INTEGER NOT NULL,
  missing_count  INTEGER NOT NULL,
  -- A gap can close later: the missing leaves may simply be draining out
  -- of queue.py after an outage (§5). Recording the gap is not an
  -- accusation, and resolving it must not mean deleting the record.
  resolved_at    TEXT,
  observed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_component_gaps_component
  ON component_counter_gaps(component_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_component_gaps_open
  ON component_counter_gaps(component_id)
  WHERE resolved_at IS NULL;
