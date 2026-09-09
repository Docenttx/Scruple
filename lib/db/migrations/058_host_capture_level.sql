-- Migration 058 — who supplied the meaning, and whether anybody did (WO-D6).
--
-- The gate observes a WIRE. A wire carries bytes and a workflow graph; it does
-- not carry the fact that those pixels were the viewport of scene X at frame Y
-- through camera Z. That is not a defect in the gate — it is what "observed in
-- transit through a proxy the measured party cannot route around" means.
--
-- lib/capture/hostRegistry.ts closes it with exactly two levels:
--
--   LEVEL 1  the host points its ComfyUI address at the gate. No code from us,
--            no registration, full byte coverage — and a record that is
--            honestly SEMANTICALLY BLIND: an anonymous PNG was uploaded.
--   LEVEL 2  the host registers an adapter, which supplies the meaning and
--            ONLY the meaning. It never observes bytes, opens a socket or
--            touches a key.
--
-- ⚑ THE LEVEL IS ON THE LEAF, AND LEVEL 1 SAYS SO. This is the whole point of
-- the migration. A Level-1 leaf that merely LACKED the semantics would be
-- indistinguishable from a Level-2 leaf whose adapter was broken, and from a
-- leaf written before the field existed. `host_semantics` is therefore
-- three-valued and NOT NULL for anything a component emits, and
-- services/scruple-capture/src/leaf.ts DEFAULTS it to 'blind' so that no
-- adapter can forget to declare its own absence — the absence is declared by
-- the code that runs when there is no adapter.
--
-- ⚑ 'declined' IS NOT A DEGRADED 'blind', AND THE COLUMN KEEPS THEM APART.
-- An adapter that was registered and had nothing to say about this observation
-- is an integration that is NOT WORKING. No adapter at all is an integration
-- that was NEVER DONE. Different fixes, different owners, different queries —
-- exactly the distinction migration 057 holds open between `not_queried` and
-- `evicted_or_restarted`, for the same stated reason.
--
-- NULL IS THE LEGACY VALUE AND IT IS NOT BACKFILLED, for 053, 056 and 057's
-- reason: NULL is "the question was never asked of this leaf" — canvas, the
-- desktop plugins, everything with no capture block. Defaulting those to
-- 'blind' would manufacture an answer nobody gave, and would assert that a
-- host hook existed and reported nothing when in fact none was reachable.

ALTER TABLE iterations ADD COLUMN host TEXT;
ALTER TABLE iterations ADD COLUMN host_adapter TEXT;
ALTER TABLE iterations ADD COLUMN host_evidence_type TEXT;

-- The manifest and its digest, stored together for the reason
-- `model_fingerprints` and `model_fingerprints_hash` are: only the HASH enters
-- the MAC, and the document is what makes the stored leaf legible. The route
-- recomputes the hash from the document and REFUSES a submission whose two
-- halves disagree, so a row that carries both carries the server's arithmetic
-- as well as the component's.
ALTER TABLE iterations ADD COLUMN host_evidence TEXT;
ALTER TABLE iterations ADD COLUMN host_evidence_hash TEXT;

-- ⚑ THE CROSS-COLUMN CHECKS ARE THE POINT, exactly as in 053, 056 and 057.
-- Three guards say the same thing and none of them is the same guard twice:
-- the types in lib/capture/hostRegistry.ts stop the code being written,
-- lib/leaf/captureClaims.ts rule 7 stops the JSON arriving — types do not
-- survive a wire — and this stops any other writer, present or future, that
-- reaches the table through neither.
--
--   1. A LEVEL-2 VALUE NEEDS AN ADAPTER. 'supplied' and 'declined' both assert
--      that somebody was registered. A leaf claiming a host supplied its
--      meaning while naming nobody is a coverage claim with nothing behind it.
--   2. 'blind' MAY NAME NOBODY AND CARRY NOTHING. Blind means no adapter was
--      reachable; a host id or an evidence document beside it is two
--      statements that cannot both be true.
--   3. 'supplied' NEEDS A DOCUMENT, AND 'declined' MAY NOT HAVE ONE. The two
--      halves of one collapse: the first supplies nothing and calls it
--      supplied, the second declines and ships a document anyway.
--
-- Existing rows are unaffected: every comparison against NULL evaluates to
-- NULL, which a CHECK admits.
ALTER TABLE iterations ADD COLUMN host_semantics TEXT
  CHECK (
    host_semantics IN ('blind', 'declined', 'supplied')
    AND NOT (host_semantics <> 'blind' AND host_adapter IS NULL)
    AND NOT (
      host_semantics = 'blind'
      AND (host IS NOT NULL OR host_adapter IS NOT NULL
           OR host_evidence_type IS NOT NULL OR host_evidence_hash IS NOT NULL
           OR host_evidence IS NOT NULL)
    )
    AND NOT (host_semantics = 'supplied' AND host_evidence_hash IS NULL)
    AND NOT (
      host_semantics = 'declined'
      AND (host_evidence_hash IS NOT NULL OR host_evidence IS NOT NULL)
    )
  );

-- "Show me every leaf nobody named" and "show me every leaf a broken adapter
-- passed over" are the two queries an operator runs when a host integration is
-- reported not working. Without this both are a table scan over every leaf the
-- estate holds, which is the kind of query an operator stops running.
CREATE INDEX IF NOT EXISTS idx_iterations_host_semantics
  ON iterations(host_semantics) WHERE host_semantics IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iterations_host
  ON iterations(host) WHERE host IS NOT NULL;
