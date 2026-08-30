-- Migration 045 — the published-builds registry (H-4 §10 C-4).
--
-- WO-15. C-4 records the defect this closes: §4.3 says "because we
-- publish the component, the server can check the claimed build is one we
-- shipped — the first time P1 is checkable at ingest rather than
-- attested", and there was nothing to check it AGAINST. A claimed
-- measurement was compared only to the value the same component
-- provisioned with, which is drift detection: it notices that a component
-- changed, and cannot tell a published build from a string somebody typed.
--
-- TWO TABLES, AND WHY IT IS NOT ONE MUTABLE ROW.
--
--   `published_builds` is IMMUTABLE-APPEND. A row is written once, at
--   publication, and never updated or deleted. Its signature covers
--   exactly the publication facts, so it stays verifiable forever.
--
--   `published_build_events` carries everything that happens to a build
--   AFTER publication — withdrawal, supersession, and the reinstatement
--   that corrects a mistaken withdrawal. Each event is separately signed
--   and separately timestamped, and the current status of a build is the
--   FOLD of its events as of a reference time.
--
--   The alternative — one mutable row with `withdrawn_at` UPDATEd in
--   place — fails on two counts, and both matter here rather than in
--   the abstract:
--
--     1. The publication signature would have to cover `withdrawn_at`,
--        so withdrawing a build means RE-SIGNING its publication record.
--        After that there is no longer any artifact attesting that the
--        build was published, unwithdrawn, on the day the leaf was
--        signed — which is the exact question a verifier holding an old
--        leaf needs answered. Withdrawal would destroy the evidence that
--        makes withdrawn leaves still checkable.
--
--     2. A WITHDRAWN BUILD MUST REMAIN CHECKABLE FOR LEAVES ALREADY
--        SIGNED UNDER IT. Deletion is therefore not available, and
--        neither is a status column that only knows `now`. Status is
--        evaluated AS OF a time (lib/builds/registry.ts
--        buildRegistryStatus(measurement, asOf)); a leaf verified at T
--        asks the registry what the build was at T, and a withdrawal at
--        T+1 cannot reach backwards and change that answer.
--
--   Same shape as `component_counter_gaps.resolved_at` in 041: a gap
--   that later drains is RESOLVED, never deleted, because "it went wrong
--   and then recovered" is a different fact from "nothing ever went
--   wrong". Withdrawal is that principle applied to the registry.
--
-- WHAT THE SIGNATURE IS WORTH, stated here rather than discovered later.
-- Ed25519 over the canonical preimage (lib/ratchet/ratchet.ts
-- canonicalPreimage — the same code-point-sorted, float-refusing
-- serialisation the event MAC uses, because two canonicalisations are two
-- formats). The private key lives in SCRUPLE_BUILD_REGISTRY_KEY_HEX and
-- NEVER in this database. So write access to the database alone does not
-- let anyone add a build that verifies, and a registry served from a
-- compromised host can be checked against a public key held elsewhere.
-- It is NOT a claim about the build's contents: it says Scruple published
-- this measurement, not that the bytes behind it are good.
--
-- AND THE LIMIT ABOVE ALL OF IT (§4.3, unchanged by this migration): a
-- modified build can claim any measurement string, including a published
-- one. What it cannot do is produce a valid MAC without the IK. Registry
-- plus key, not registry alone.

CREATE TABLE IF NOT EXISTS published_builds (
  -- 'sha256:<64 lowercase hex>'. The measurement itself is the identity:
  -- two publications of the same bytes are the same build, and the
  -- PRIMARY KEY says so rather than a uniqueness convention nobody
  -- enforces.
  measurement        TEXT PRIMARY KEY
                       CHECK (length(measurement) = 71
                              AND substr(measurement, 1, 7) = 'sha256:'
                              AND substr(measurement, 8) NOT GLOB '*[^0-9a-f]*'),

  -- Which artifact this measures — 'scruple-capture' today.
  component_name     TEXT NOT NULL,
  version            TEXT NOT NULL,

  -- HOW the measurement was taken, because two methods produce two
  -- incomparable strings and a registry that conflates them is worse
  -- than none. 'source-tree' is services/scruple-capture/src/
  -- build-measurement.ts's own digest — what a component can measure
  -- about itself with no help. 'image-digest' is the container digest
  -- the vendor's registry publishes, which that file's header says a
  -- real deployment SHOULD prefer.
  measurement_kind   TEXT NOT NULL DEFAULT 'source-tree'
                       CHECK (measurement_kind IN ('source-tree', 'image-digest')),

  published_at       TEXT NOT NULL,
  notes              TEXT,

  -- Detached signature over the canonical preimage of the publication
  -- facts above. `entry_sha256` is sha256 of those exact bytes, stored so
  -- a mismatch localises to "the row was edited" rather than to "the
  -- signature is bad", which are different incidents.
  signature_alg      TEXT NOT NULL DEFAULT 'ed25519',
  signing_key_id     TEXT NOT NULL,
  signature          TEXT NOT NULL,
  entry_sha256       TEXT NOT NULL,

  recorded_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_published_builds_component
  ON published_builds (component_name, published_at DESC);


-- Everything that happens to a build after publication. APPEND ONLY.
CREATE TABLE IF NOT EXISTS published_build_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  measurement    TEXT NOT NULL REFERENCES published_builds(measurement),

  -- 'withdrawn'   — do not deploy this build. Says nothing about leaves
  --                 already signed under it; see the header.
  -- 'superseded'  — a newer build replaces it. NOT a withdrawal: a
  --                 component still running a superseded build is behind,
  --                 not suspect, and collapsing the two would make "you
  --                 are out of date" and "we revoked this" the same
  --                 signal to a vendor deciding whether to roll back.
  -- 'reinstated'  — the correcting event for a withdrawal that should not
  --                 have happened. It exists so that a mistake is fixed
  --                 by APPENDING rather than by editing history, which is
  --                 the whole reason this table is append-only.
  event          TEXT NOT NULL
                   CHECK (event IN ('withdrawn', 'superseded', 'reinstated')),

  -- Set on 'superseded'. Points at the build that replaces this one.
  superseded_by  TEXT REFERENCES published_builds(measurement),
  reason         TEXT,

  -- WHEN THE EVENT TAKES EFFECT, which is not when the row was written.
  -- A withdrawal decided at 09:00 and recorded at 11:00 has to be able to
  -- say 09:00, or every leaf in those two hours gets the wrong answer
  -- from a status query. Both are kept; only this one is folded.
  effective_at   TEXT NOT NULL,

  signature_alg  TEXT NOT NULL DEFAULT 'ed25519',
  signing_key_id TEXT NOT NULL,
  signature      TEXT NOT NULL,
  entry_sha256   TEXT NOT NULL,

  recorded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_published_build_events_fold
  ON published_build_events (measurement, effective_at, id);


-- What the registry said about this event's claimed build AT INGEST.
--
-- NULL is not 'unpublished'. NULL means the registry was not consulted —
-- true of every row written before this migration, and of any row whose
-- envelope carried no measurement at all. That is migration 043's
-- `component_verified` reasoning applied here: a nullable column would
-- let "no build declared" and "build declared and unrecognised" share a
-- spelling, and the second is the one this whole work order exists to
-- make visible.
--
-- 'unpublished' rows are RECORDED, NOT REJECTED. The argument is in
-- lib/builds/registry.ts and docs/canon/PUBLISHED_BUILDS.md §3; the short
-- form is that refusing the leaf does not un-produce the artifact, it
-- produces an artifact with no leaf — converting a flagged fact into a
-- silence, which is the one trade this design exists to refuse.
ALTER TABLE component_events ADD COLUMN build_status TEXT;

CREATE INDEX IF NOT EXISTS idx_component_events_build_status
  ON component_events (build_status, verified_at DESC)
  WHERE build_status IS NOT NULL AND build_status <> 'published';
