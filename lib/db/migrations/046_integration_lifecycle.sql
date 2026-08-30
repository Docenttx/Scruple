-- Migration 046 — the integration lifecycle: integrating → verifying →
-- sealed, and `resealing` when an approved deployment changes.
--
-- WO-22, implementing docs/canon/INTEGRATION_LIFECYCLE.md. That document
-- is the founder direction and its sequence is the whole point:
--
--   1. Integrate — vendor builds against the SDK, their topology.
--   2. Test end to end — conformance probes, REAL LEAVES FLOWING.
--   3. THEN seal — measure the pipeline, approve the configuration.
--
-- "You cannot hash a moving target." Measuring during step 1 produces a
-- hash that is stale before it is recorded and teaches the vendor that the
-- measurement is noise.
--
-- ─────────────────────────────────────────────────────────────────────
-- WHY THIS IS 045'S SHAPE AND NOT A SECOND ONE
--
-- The published-builds registry already solved "withdraw a thing without
-- breaking the history of what was signed under it": an IMMUTABLE signed
-- row per artefact, an APPEND-ONLY table of separately signed events
-- beside it, and a status that is a FOLD OF THOSE EVENTS AS OF A TIME
-- rather than a mutable column read as of now. Every line of that
-- argument (045's header, docs/canon/PUBLISHED_BUILDS.md §1) applies here
-- unchanged, with `reseal` where `withdraw` was:
--
--   * If the seal state lived on the seal row, re-sealing would mean
--     RE-SIGNING it, and there would no longer be any artifact attesting
--     that the deployment was sealed, under seal X, on the day a leaf was
--     written. That is exactly the question an auditor holding an old
--     leaf has.
--
--   * A superseded seal must remain checkable for leaves already written
--     under it. So deletion is unavailable, and so is a status that only
--     knows `now`. `sealStatus(deployment_id, asOf)` takes the instant as
--     an argument; a reseal effective at T+1 is not in the fold for a
--     leaf written at T and cannot reach backwards.
--
-- ONE PLACE THIS SHAPE DIFFERS FROM 045, DELIBERATELY.
--
-- Build lifecycle events are INDEPENDENT FACTS — withdrawal and
-- supersession are folded separately precisely because order-sensitivity
-- there was a bug. Deployment lifecycle events are a SEQUENCE: `sealed`
-- is legal after `verifying` and illegal after `integrating`, and that
-- legality is evaluated against the state as of the event's own
-- `effective_at`. An event inserted BEHIND the newest existing one would
-- silently re-order the fold and could make an already-recorded
-- transition illegal after the fact. So `effective_at` is required to be
-- monotonically non-decreasing per deployment, enforced in
-- lib/seal/registry.ts. Backdating within the gap since the last event is
-- still allowed, because a decision taken at 09:00 and recorded at 11:00
-- must be able to say 09:00 — 045's reason, unchanged.
-- ─────────────────────────────────────────────────────────────────────


-- The deployment. A NAME, not evidence: nothing here is signed, because
-- nothing here is a claim. Every claim about this deployment lives in
-- `deployment_seals` (what was approved) and `deployment_lifecycle_events`
-- (what happened), both signed.
CREATE TABLE IF NOT EXISTS deployments (
  -- Vendor-chosen and tenant-scoped in practice; globally unique here so
  -- a leaf can carry it as one string. Uniqueness is checked against the
  -- OWNING TENANT on every read (lib/seal/registry.ts), so claiming
  -- another tenant's id buys nothing.
  deployment_id  TEXT PRIMARY KEY,
  tenant_id      TEXT NOT NULL,
  label          TEXT,
  -- The instant the `integrating` event was effective. No lifecycle event
  -- may predate it: a deployment cannot have done something before it
  -- existed, and admitting one would be the retroactivity the as-of fold
  -- exists to prevent, arriving through the front door.
  created_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployments_tenant ON deployments (tenant_id);


-- A SEAL. Immutable, one row per approval, signed.
--
-- It is a pipeline measurement plus the approved-configuration manifest
-- that produced it. The manifest is stored in full, not just its digest,
-- because a measurement nobody can reproduce is a number rather than
-- evidence — `verifySealMeasurement()` recomputes it from this column.
CREATE TABLE IF NOT EXISTS deployment_seals (
  -- 'sha256:<64 hex>' OF THE EXACT BYTES THAT WERE SIGNED. The identity
  -- is derived from the statement rather than assigned beside it, so a
  -- row that was edited cannot keep its identity — which is why there is
  -- no separate `entry_sha256` column here and there is one in 045.
  -- There, `measurement` is an EXTERNAL identity (the component computed
  -- it) and the digest of the signed bytes is a second, different fact.
  -- Here they are the same fact and storing it twice would invite them to
  -- disagree.
  seal_ref             TEXT PRIMARY KEY
                         CHECK (length(seal_ref) = 71
                                AND substr(seal_ref, 1, 7) = 'sha256:'
                                AND substr(seal_ref, 8) NOT GLOB '*[^0-9a-f]*'),

  deployment_id        TEXT NOT NULL REFERENCES deployments(deployment_id),

  -- The measurement over the DECLARED manifest below. Not a directory
  -- walk: services/witness-server/tamper-surface.mjs gives the reason in
  -- its own comment — "a walk would silently include whatever someone
  -- drops in the directory, which is the opposite of a tamper surface".
  pipeline_measurement TEXT NOT NULL
                         CHECK (length(pipeline_measurement) = 71
                                AND substr(pipeline_measurement, 1, 7) = 'sha256:'),

  -- Which formula produced it. 045 learned this the expensive way for
  -- builds (`measurement_kind`): two methods produce two incomparable
  -- strings for one artefact, and a registry that conflates them is worse
  -- than none.
  measurement_profile  TEXT NOT NULL DEFAULT 'scruple/pipeline-measurement/v1',

  -- The canonical manifest JSON. This is what "the approved
  -- configuration" MEANS, in full, on the row.
  manifest_json        TEXT NOT NULL,

  sealed_at            TEXT NOT NULL,
  notes                TEXT,

  signature_alg        TEXT NOT NULL DEFAULT 'ed25519',
  signing_key_id       TEXT NOT NULL,
  signature            TEXT NOT NULL,

  recorded_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deployment_seals_deployment
  ON deployment_seals (deployment_id, sealed_at DESC);


-- Everything that happens to a deployment. APPEND ONLY, each row signed.
CREATE TABLE IF NOT EXISTS deployment_lifecycle_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id TEXT NOT NULL REFERENCES deployments(deployment_id),

  -- 'integrating'     — the deployment exists and is being built against
  --                     the SDK. Written once, at registration, and
  --                     REFUSED thereafter: a second one would reset the
  --                     fold and clear an outstanding material change,
  --                     which is a history eraser wearing the name of a
  --                     beginning.
  -- 'verifying'       — end-to-end testing has started. Real leaves flow
  --                     from here and are NOT claims to the standard.
  -- 'sealed'          — this seal_ref is the approved configuration from
  --                     `effective_at`. Legal only from 'verifying' or
  --                     'resealing'; INTEGRATING → SEALED IS REFUSED,
  --                     because step 2 of the lifecycle is not optional.
  -- 'material_change' — a change inside the boundary that could change
  --                     what a leaf says or whether a leaf is produced.
  --                     Sets the state to 'resealing'. Only an explicit
  --                     'sealed' clears it — 045's rule that a strong
  --                     statement is undone by a named event and never as
  --                     a side effect of a routine one.
  -- 'drift'           — a CONSEQUENTIAL change: one that cannot alter
  --                     what a leaf says but did move bytes inside the
  --                     boundary (a pinned dependency bump). Recorded,
  --                     not resealed — and COUNTED, so that "not
  --                     material" cannot accumulate into a different
  --                     pipeline. See lib/seal/materiality.ts.
  event         TEXT NOT NULL
                  CHECK (event IN ('integrating', 'verifying', 'sealed',
                                   'material_change', 'drift')),

  -- Set on 'sealed'. Which approval took effect.
  seal_ref      TEXT REFERENCES deployment_seals(seal_ref),

  -- Set on 'material_change' and 'drift'. The classification that was
  -- made, recorded on the event so an auditor reads the JUDGEMENT rather
  -- than re-deriving it from two manifests years later.
  change_class  TEXT CHECK (change_class IN ('material', 'consequential', 'administrative')),

  reason        TEXT,

  -- When it took effect, which is not when the row was written.
  effective_at  TEXT NOT NULL,

  signature_alg  TEXT NOT NULL DEFAULT 'ed25519',
  signing_key_id TEXT NOT NULL,
  signature      TEXT NOT NULL,
  entry_sha256   TEXT NOT NULL,

  recorded_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deployment_lifecycle_fold
  ON deployment_lifecycle_events (deployment_id, effective_at, id);


-- Which deployment a capture component belongs to.
--
-- Nullable and unset for every component that provisioned before this
-- migration. NULL is not "no deployment" as a finding; it is a component
-- that was never bound to one, which is what every component in the
-- estate is today.
ALTER TABLE components ADD COLUMN deployment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_components_deployment
  ON components (deployment_id);


-- ─────────────────────────────────────────────────────────────────────
-- THE LOAD-BEARING PART: A LEAF RECORDS THE SEAL STATE IT WAS WRITTEN
-- UNDER.
--
-- INTEGRATION_LIFECYCLE.md §"Two things this raises": step 2 produces
-- real leaves from an unsealed pipeline. If they are not marked, then the
-- moment a vendor seals they hold a pile of integration-era leaves
-- INDISTINGUISHABLE FROM APPROVED ONES, and the first audit cannot tell
-- which configuration produced what.
--
-- The vocabulary is the estate's existing one and no new words were
-- coined for distinctions that already have them:
--
--   'integrating' / 'verifying' / 'sealed' / 'resealing'
--                  — the fold, as of the instant this leaf was written.
--   'unregistered' — a deployment_id was DECLARED and we have no record
--                    of it (or it belongs to another tenant). The exact
--                    analogue of 045's `unpublished`: declared, and not
--                    ours.
--   'undeclared'   — no deployment was declared at all. 045's word, for
--                    045's case: canvas and the plugins carry no
--                    component and no deployment, and "nothing was said"
--                    is not the same fact as "something was said and we
--                    do not recognise it".
--   'unchecked'    — OUR failure, named rather than swallowed. 045 again:
--                    "an inconclusive is never a pass."
--
--   NULL           — the question was never asked. Every row written
--                    before this migration. Migration 043 spells the same
--                    rule for `component_verified`; 045 spells it for
--                    `build_status`. A nullable column is the only way
--                    "we did not look" and "we looked and found nothing"
--                    stay different facts.
--
-- AND IT IS NOT A TIER. Compliance stays binary (Standard §5). Only
-- `sealed` may claim the standard; everything else is one side of a line,
-- not a rung on a ladder.
ALTER TABLE iterations ADD COLUMN deployment_id TEXT;
ALTER TABLE iterations ADD COLUMN seal_state    TEXT;

-- The seal identity this leaf was written under, and NULL unless
-- `seal_state = 'sealed'`.
--
-- A leaf written during 'resealing' has a last-approved seal, and putting
-- it here would read as "approved under X" — which is the one thing that
-- is not true of it: `resealing` means the configuration has moved AWAY
-- from X. The last-approved seal is still recoverable from the fold, as
-- of that leaf's timestamp, by anyone who wants it. It is not stamped on
-- the leaf as though it applied.
ALTER TABLE iterations ADD COLUMN seal_ref      TEXT;

CREATE INDEX IF NOT EXISTS idx_iterations_seal_state
  ON iterations (seal_state, timestamp DESC)
  WHERE seal_state IS NOT NULL AND seal_state <> 'sealed';
