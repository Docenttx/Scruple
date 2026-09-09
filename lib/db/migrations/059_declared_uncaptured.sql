-- Migration 059 — the absence set, and the scope it enumerated over (WO-E2).
--
-- WO-C5 built the machinery this depends on and stopped before the set itself,
-- because its scope rule was unsettled. Round 5 §3 put the question to Coder as
-- a question rather than a ruling:
--
--   "must `declared_uncaptured` carry the scope it enumerated over — which root
--   types were configured, and whether any were `unspecified` — or does it
--   assert a closure it does not have? That is your own measured-or-unknown
--   invariant applied one level up: THE COMPLETENESS OF THE ABSENCE SET IS
--   ITSELF A FACT, and it needs a source like every other fact."
--
-- and line 369 answered it: the record needs the configured volume types and
-- roots, the query interval or history watermark, whether any `unspecified`
-- volume exists, and A COMPLETENESS RESULT — with a complete enumeration
-- permitted "only when all relevant typed roots are covered and no relevant
-- root is `unspecified`". `docs/canon/DECLARED_UNCAPTURED.md` is that answer
-- made decidable, and was committed before the code that implements it.
--
-- ⚑ THREE SCALARS AND A DOCUMENT, AND THE SPLIT IS THE SAME ONE 058 MADE.
-- The set is a LIST and cannot ride in a MAC preimage, so the document is
-- stored beside `host_evidence` and only its DIGEST is signed
-- (`declared_uncaptured_hash`). The route recomputes the digest from the
-- document and refuses a pair that disagrees, so the unsigned half stays
-- honest.
--
-- ⚑ AND `declared_uncaptured_count` IS SIGNED SEPARATELY EVEN THOUGH THE
-- DOCUMENT CARRIES IT. 0 is "the component enumerated and found nothing
-- uncaptured"; NULL is "the component did not enumerate". Those are different
-- operational conditions with different owners, and CHECK 2 below is what
-- stops the second from being written where the first belongs. It is the same
-- distinction 058 holds open between `blind` and `declined`, and 057 between
-- `not_queried` and `evicted_or_restarted`.
--
-- NULL IS THE LEGACY VALUE AND IT IS NOT BACKFILLED, for 053's, 056's, 057's
-- and 058's reason: NULL is "the question was never asked of this leaf";
-- 'not_enumerated' is "asked, and there was nothing to enumerate".

ALTER TABLE iterations ADD COLUMN uncaptured_enumeration_method TEXT
  CHECK (uncaptured_enumeration_method IN ('live_history', 'none'));

ALTER TABLE iterations ADD COLUMN uncaptured_scope TEXT
  CHECK (uncaptured_scope IN ('complete', 'partial', 'not_enumerated'));

ALTER TABLE iterations ADD COLUMN uncaptured_scope_source TEXT
  CHECK (uncaptured_scope_source IN ('measured', 'unknown'));

ALTER TABLE iterations ADD COLUMN declared_uncaptured_hash TEXT;

-- The canonical bytes that were hashed, not a re-serialisation of them, so a
-- verifier holding this column can reproduce `declared_uncaptured_hash`
-- directly. Same correction `model_fingerprints` and `host_evidence` carry.
ALTER TABLE iterations ADD COLUMN declared_uncaptured TEXT;

-- ⚑ THE CROSS-COLUMN CHECKS ARE THE POINT, exactly as in 053, 056, 057 and
-- 058. Three guards say the same thing and none of them is the same guard
-- twice: the types in lib/capture/declaredUncaptured.ts stop the code being
-- written, lib/leaf/captureClaims.ts rule 8 stops the JSON arriving — types do
-- not survive a wire — and this stops any other writer, present or future,
-- that reaches the table through neither.
--
--   1. NOTHING ENUMERATED MEANS NOTHING COUNTED AND NOTHING HASHED. A
--      'not_enumerated' row carrying a set is a claim about a set nobody built.
--   2. ⚑ AN ENUMERATED SCOPE ALWAYS HAS A COUNT, AND 0 IS A COUNT. This is
--      "the empty set is present, not absent" in SQL. Without it the two states
--      the whole field exists to distinguish — "looked and found nothing" and
--      "did not look" — are one NULL.
--   3. A SCOPE CLAIM NEEDS A METHOD BEHIND IT. `uncaptured_enumeration_method
--      = 'none'` beside a scope other than 'not_enumerated' is a completeness
--      result produced by no enumeration.
--   4. A NON-EMPTY SET NEEDS ITS DOCUMENT. A count above zero with no stored
--      document is a cardinality nobody can read the members of, which is the
--      bare hole this field exists to close wearing a number.
--
-- ⚑ AND NOTE WHAT IS *NOT* REFUSED: `uncaptured_scope = 'complete'` with
-- `uncaptured_scope_source = 'unknown'`. Those are two facts, not a
-- contradiction — every condition closure requires held as the component
-- measured them, and nobody outside the box confirmed the history window.
-- Coder, round 5 fact (b): "completeness is source: unknown unless an
-- independent observer establishes the relevant history window and
-- continuity." That blocker is POLICY and lives in the validator, where it can
-- lift without a schema change; putting it here would make a future
-- independent observer a migration.
--
-- Existing rows are unaffected: every comparison against NULL evaluates to
-- NULL, which a CHECK admits.
ALTER TABLE iterations ADD COLUMN declared_uncaptured_count INTEGER
  CHECK (
    (declared_uncaptured_count IS NULL OR declared_uncaptured_count >= 0)
    AND NOT (
      uncaptured_scope = 'not_enumerated'
      AND (declared_uncaptured_count IS NOT NULL OR declared_uncaptured_hash IS NOT NULL)
    )
    AND NOT (
      uncaptured_scope IS NOT NULL
      AND uncaptured_scope <> 'not_enumerated'
      AND (declared_uncaptured_count IS NULL OR declared_uncaptured_hash IS NULL)
    )
    AND NOT (
      uncaptured_enumeration_method = 'none'
      AND uncaptured_scope IS NOT NULL
      AND uncaptured_scope <> 'not_enumerated'
    )
    AND NOT (declared_uncaptured_count > 0 AND declared_uncaptured IS NULL)
  );

-- "Show me every leaf whose absence set is not a closure" and "show me every
-- leaf that named an artifact it could not capture" are the two queries an
-- auditor runs after a coverage question is raised. Without these both are a
-- table scan over every leaf the estate holds, which is the kind of query an
-- auditor stops running.
CREATE INDEX IF NOT EXISTS idx_iterations_uncaptured_scope
  ON iterations(uncaptured_scope) WHERE uncaptured_scope IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iterations_declared_uncaptured_count
  ON iterations(declared_uncaptured_count) WHERE declared_uncaptured_count > 0;
