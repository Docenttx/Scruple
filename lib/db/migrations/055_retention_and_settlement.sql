-- Migration 055 — the retention policy registry, and the settlement binding
-- stored per leaf (WO-C3).
--
-- Architect's SECOND settle condition on the claims-versus-evidence split:
--
--   "the `retention_policy_digest` must bind evidence RETENTION DURATION, not
--    just policy identity, so a resolution attempt after the evidence is
--    legitimately gone yields a named `evidence_expired` state rather than
--    being INDISTINGUISHABLE FROM A FORGED HANDLE."
--
-- Measured on this estate before the change: a leaf whose row had been reaped
-- and a leaf id nobody ever issued produced BYTE-IDENTICAL 404s, and the
-- resolution path did not exist at all. Recorded in
-- /mnt/corpus/scruple-council-impl/wo-c3/01-controls-RED.txt.
--
-- ⚑ TWO CLASSES OF FACT LIVE IN THESE COLUMNS AND THEY ARE NOT THE SAME CLASS.
--
--   SIGNED BY THE COMPONENT   resolution_settlement_deadline
--                             resolution_retention_policy_digest
--     Inside the MAC preimage (WO-C2's block, handles six and seven), so a
--     party in the middle can neither push a deadline out nor swap a policy
--     for a longer-lived one. Stored VERBATIM — what the component signed,
--     never what this server would have preferred.
--
--   MEASURED BY THIS SERVER   settlement_clock, settlement_clock_authority,
--                             settlement_observed_at, evidence_retained_until
--     Read from a NAMED CLOCK at ingest. Architect: "`expired` must itself be
--     `source: measured` against a named clock, since a deadline derived from
--     a locally-set timestamp is exactly the config-inherited field class we
--     already refused."
--
-- The prefixes say which class a column is in, and the receipt discloses them
-- separately for the same reason.

-- ---------------------------------------------------------------------------
-- The registry. What a digest RESOLVES TO — durations, not a name.
-- ---------------------------------------------------------------------------
--
-- A digest that resolves to nothing is refused at ingest: it binds a policy
-- identity and no duration, which is the shape the council refused. And
-- enrolment deliberately does NOT happen at ingest — if the route recorded
-- whatever policy a submission described, every digest would resolve,
-- including a fabricated one, and the forged-handle state would collapse into
-- the resolvable state on the way in.
CREATE TABLE IF NOT EXISTS retention_policies (
  -- sha256: over the canonical policy object. The DURATIONS are inside it.
  digest                TEXT PRIMARY KEY,
  policy_id             TEXT NOT NULL,
  -- The named clock the durations are counted on. Never 'local' — see
  -- lib/leaf/namedClock.ts REFUSED_CLOCK_NAMES.
  clock                 TEXT NOT NULL,
  -- How long the checkpoint EVIDENCE is kept. The field whose absence made
  -- the digest useless.
  retention_duration_s  INTEGER NOT NULL CHECK (retention_duration_s > 0),
  -- How long an unresolved gap stays open before it is a finding. Bounded by
  -- the retention duration by CHECK, because a deadline that falls after the
  -- evidence is gone is a finding nobody can ever check.
  settlement_window_s   INTEGER NOT NULL CHECK (settlement_window_s > 0),
  policy_version        INTEGER NOT NULL,
  -- The exact bytes the digest was taken over, so a reader can recompute it
  -- without trusting the columns beside it.
  canonical_json        TEXT NOT NULL,
  enrolled_at           TEXT NOT NULL,
  CHECK (settlement_window_s <= retention_duration_s)
);

-- The default policy: thirty days of evidence, one day to settle.
--
-- ⚑ THE DIGEST HERE IS A LITERAL AND `DEFAULT_RETENTION_POLICY_DIGEST` IN
-- lib/leaf/retentionPolicy.ts IS COMPUTED, and test/v2/retention-settlement.ts
-- asserts the two agree. A seeded row whose digest came from a different
-- version of that function would resolve for nobody and would look exactly
-- like a policy somebody forgot to enrol. Same discipline as the shared
-- preimage vectors: two independent expressions of one value, and a test
-- between them.
INSERT OR IGNORE INTO retention_policies
  (digest, policy_id, clock, retention_duration_s, settlement_window_s,
   policy_version, canonical_json, enrolled_at)
VALUES (
  'sha256:d2186fcbb6231b46aa5f4ca3fe2522194c468b9ae1732899daff4fa630319c95',
  'scruple-default-v1',
  'scruple-witness-v2',
  2592000,
  86400,
  1,
  '{"clock":"scruple-witness-v2","policy_id":"scruple-default-v1","retention_duration_s":2592000,"settlement_window_s":86400,"version":1}',
  '2026-09-09T00:00:00.000Z'
);

-- ---------------------------------------------------------------------------
-- The per-leaf binding.
-- ---------------------------------------------------------------------------

-- SIGNED. When this leaf's silence becomes a finding.
ALTER TABLE iterations ADD COLUMN resolution_settlement_deadline TEXT;

-- SIGNED. Which retention policy was in force — by digest, so the durations
-- are bound and not merely named.
--
-- ⚑ THE CROSS-COLUMN CHECK IS THE POINT, and it is the same guard the
-- validator applies, placed where any other writer reaching this table has to
-- pass it too — WO-C1's three-guard pattern, WO-C2's precedent one column
-- over. Existing rows are unaffected: both NULL evaluates true.
ALTER TABLE iterations ADD COLUMN resolution_retention_policy_digest TEXT
  CHECK ((resolution_settlement_deadline IS NULL)
         = (resolution_retention_policy_digest IS NULL));

-- MEASURED. The clock this server read at ingest, and who answers for the
-- reading. A deadline with no named clock beside it can never produce a
-- terminal `expired` — `evaluateSettlement()` returns `unknown` — so the CHECK
-- below refuses the row that would look settleable and is not.
ALTER TABLE iterations ADD COLUMN settlement_clock TEXT
  CHECK (NOT (resolution_settlement_deadline IS NOT NULL AND settlement_clock IS NULL));
ALTER TABLE iterations ADD COLUMN settlement_clock_authority TEXT;

-- MEASURED. The instant that clock reported when this leaf arrived.
ALTER TABLE iterations ADD COLUMN settlement_observed_at TEXT;

-- MEASURED, DERIVED. observed_at + retention_duration_s: when the EVIDENCE
-- stops existing. This is the column that makes `evidence_expired` a NAMED
-- state instead of a 404 shared with forgery.
--
-- ⚑ IT GOVERNS THE EVIDENCE, NOT THIS ROW. The leaf record must outlive the
-- evidence, because the leaf record is what answers `evidence_expired`. A
-- deployment that reaps the row as well is back to a 404 that means either
-- "legitimately gone" or "you made that up" — see docs/canon/council-impl/WO-C3.md §7.
ALTER TABLE iterations ADD COLUMN evidence_retained_until TEXT;

CREATE INDEX IF NOT EXISTS idx_iterations_settlement_deadline
  ON iterations(resolution_settlement_deadline);
