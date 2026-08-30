-- Migration 043 — the component envelope on the leaf row, and the honest
-- record of what was NOT declared.
--
-- WO-6. Two facts the /v2 ingest path was producing and then discarding.
--
--   1. WHICH COMPONENT, AT WHICH COUNTER. WO-3 built the server-side
--      ratchet (lib/ratchet/verify.ts) and WO-4 built the reconciliation
--      view on top of it, and /api/v2/witness never called either: the
--      §4.3 component envelope and its MAC arrived and nothing checked
--      them. The ratchet was decorative on the one path that matters.
--      Verification now happens in the route, and these three columns are
--      what make a stored leaf point back at the component_events row
--      that verified it. Without them a reconciliation gap and a leaf are
--      two facts about the same event with nothing joining them.
--
--      `component_verified` is NOT NULL DEFAULT 0 and that default is the
--      point: every leaf ever written before this migration was written
--      without a verified component, and 0 says so. A nullable column
--      would let "no component" and "component unchecked" share a
--      spelling, which is the distinction the column exists to make.
--
--      Canvas and plugin traffic legitimately carries no component
--      envelope. Those rows get component_id NULL and
--      component_verified 0 — recorded as unverified rather than
--      silently treated as fine, because a leaf whose producer we could
--      not identify is weaker evidence than one whose producer MACed it,
--      and a receipt should be able to say which it is holding.
--
--   2. WHETHER A MIME WAS EVER DECLARED. H-4 §7 probe 4 requires that a
--      file written directly into a tenant's output volume produce a
--      leaf. Nothing declares a MIME for such a write — there is no
--      producing node and no host API to ask — and CANON_SKELETON §5
--      property 1 forbids guessing one, so the component correctly sends
--      no MIME at all rather than the application/octet-stream that five
--      of the six shells sent. The ingest contract used to reject that
--      with a 400, which made probe 4 unsatisfiable by construction.
--
--      It is accepted now, and `mime_declared = 0` is how the row says
--      the type is unknown rather than known-to-be-bytes. That
--      distinction is load-bearing downstream: modality selection is
--      MIME-gated, so an undeclared type must present as "no modality is
--      applicable, and here is why" instead of as octet-stream, which
--      silently gates the image-only watermarker shut while looking
--      exactly like a declaration.
--
-- Additive only. Every column has a default that is true of every
-- existing row.

ALTER TABLE iterations ADD COLUMN component_id       TEXT;
ALTER TABLE iterations ADD COLUMN component_counter  INTEGER;
ALTER TABLE iterations ADD COLUMN component_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE iterations ADD COLUMN mime_declared      INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_iterations_component
  ON iterations (component_id, component_counter);
