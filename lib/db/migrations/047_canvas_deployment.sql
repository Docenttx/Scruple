-- Migration 047 — canvas gets a deployment identity.
--
-- WO-25, closing docs/canon/INTEGRATION_LIFECYCLE.md §10 item 6 and the
-- last line of its corrections:
--
--   "Canvas ingests through lib/iterations/ingest.ts, not /v2/witness, so
--    its leaves carry seal_state = NULL. Registering a deployment and
--    binding that path is the outstanding work — and it is the same
--    finding as STUDIO_IS_AN_EXEMPLAR.md."
--
-- ─────────────────────────────────────────────────────────────────────
-- WHY A ROW HERE AND NOT A CALL TO registerDeployment()
--
-- Migration 046 draws the line and this migration stays on the right side
-- of it, in 046's own words:
--
--   "The deployment. A NAME, not evidence: nothing here is signed,
--    because nothing here is a claim. Every claim about this deployment
--    lives in `deployment_seals` (what was approved) and
--    `deployment_lifecycle_events` (what happened), both signed."
--
-- A name has to exist identically in every environment — dev, test, the
-- production host — or a canvas leaf is stamped `unregistered` in one of
-- them and `integrating` in another, for reasons that are about which
-- operator ran which script rather than about the pipeline. A migration
-- is where a fact like that belongs.
--
-- NO LIFECYCLE EVENT IS INSERTED HERE, and that is not an omission:
--
--   * every lifecycle event is Ed25519-signed by the registry key
--     (lib/builds/signing.ts) and a migration has no key. An UNSIGNED row
--     in `deployment_lifecycle_events` would be a claim nobody made —
--     "write access to the database is not publication", signing.ts's own
--     sentence, and the whole reason that table is signed rather than
--     merely stored;
--   * INTEGRATION_LIFECYCLE.md §10 item 5: sealing is not a self-serve
--     act. Neither is the state that leads to it. The write path is
--     `lib/seal/cli.ts`, which reads the key locally, and the operator
--     steps are recorded in docs/canon/STUDIO_SEAL.md §6.
--
-- The fold over zero events is `integrating` (lib/seal/registry.ts
-- foldAsOf), which is the honest state for a deployment that has been
-- named and whose end-to-end verification nobody has yet attested. It is
-- step 1, and step 1 is an ordinary place to be.
--
-- ONE CONSEQUENCE, STATED SO IT IS NOT DISCOVERED AT A PROMPT:
-- `lib/seal/cli.ts register studio-canvas-shared-default` will now fail
-- with `already_registered`, correctly — "deployment ids are the identity
-- a leaf carries; reusing one would merge two vendors' histories into one
-- fold". The first signed event for this deployment is therefore recorded
-- with `cli.ts verifying`, or with an explicit `integrating` if an
-- operator wants the registration itself attested; `appendLifecycleEvent`
-- permits `integrating` while no event exists, and refuses a second one.
--
-- ─────────────────────────────────────────────────────────────────────
-- WHAT IS NOT BACKFILLED, AND WHY
--
-- Every canvas leaf written before this migration keeps `seal_state
-- NULL`. 046: "NULL — the question was never asked." Stamping those rows
-- now with a state resolved today would be answering, retroactively, a
-- question that was not asked when they were written — the exact
-- retroactivity the as-of fold exists to prevent. The seal state of a
-- leaf is a fact about the instant it was written, and there is no
-- instant to re-run for a row that predates the machinery.

INSERT OR IGNORE INTO deployments (deployment_id, tenant_id, label, created_at)
VALUES (
  'studio-canvas-shared-default',
  -- Scruple-as-vendor, not the artist. A hosting vendor's deployment
  -- produces leaves for its tenants; the tenants do not each own one.
  -- Deliberately not a spelling any `users` row can hold, so no request
  -- can arrive carrying it. lib/canvas/deployment.ts carries the argument.
  'platform:scruple-studio',
  'Studio canvas — Modal-hosted ComfyUI, shared-default machine (H-4 §7: certification is per configuration)',
  '2026-08-31T00:00:00.000Z'
);
