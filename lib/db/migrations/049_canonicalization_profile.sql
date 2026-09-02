-- Migration 049 — which canonicalization rule a row was written under.
--
-- CANONICALIZATION.md §5, "What was *not* done, and needs a decision":
--
--   "No column records which profile a row was written under. The fixtures
--    make the four rows replayable BECAUSE WO-21 IDENTIFIED THEM BY HAND. A
--    `canonicalization_profile` column, defaulting to `insertion-order-1` for
--    rows before 2026-07-13 and `jcs-1` after, is the durable fix. It is a
--    migration, and lib/db/migrations/** was out of this WO's scope."
--
-- This is that migration.
--
-- WHY IT MATTERS, in the words of the finding it closes: commit ec188d6
-- (2026-07-13, "WO-A2 canonical workflow_hash — sorted keys, whitespace-free")
-- was the right change and it shipped WITHOUT A VERSION MARKER. Iterations
-- 166-169 carry `leaf_scheme: 'v2.2'`, identical to the rows written after it.
-- Nothing in the record tells an auditor which rule to replay, so replaying
-- them under the documented preimage produces a mismatch — and a mismatch is
-- the exact signature of tampering. The estate has now demonstrated it will
-- change a preimage rule again; a row that cannot say which rule made it is a
-- row that will be unverifiable the next time one changes.
--
-- `leaf_scheme` cannot carry this. registry.yaml's `leaf_schemes` govern WHICH
-- FIELDS enter a preimage and in what order; they say nothing about how a
-- field's own document becomes bytes. Two orthogonal axes, and a replay needs
-- both — which is why the registry already carries `canonicalization_profiles`
-- beside `leaf_schemes`, and why this is a new column rather than a bump.

ALTER TABLE iterations ADD COLUMN canonicalization_profile TEXT;
ALTER TABLE log_leaves ADD COLUMN canonicalization_profile TEXT;

-- The backfill states THE RULE THAT WAS IN FORCE, not the rule that happens to
-- reproduce the row today. Those differ, and the difference is the trap:
--
--   iteration 165 (2026-07-05) reproduces under BOTH profiles, because its
--   graph's keys were already in sorted order. Measured, not assumed. It is
--   still an `insertion-order-1` row — it was written before ec188d6 — and
--   labelling it `jcs-1` because jcs-1 also reproduces it would be recording a
--   coincidence of this corpus as a fact about the record. CANONICALIZATION.md
--   §5 makes exactly this point about the four: "That is a coincidence of this
--   corpus, not a property of the profile."
--
-- Measured before writing this file, across all 17 rows carrying a
-- workflow_hash:
--
--   165           BOTH agree              (pre-ec188d6, keys already sorted)
--   166-169       insertion-order-1 ONLY  (the four WO-21 found by hand)
--   171, 172      jcs-1 only              (2026-07-13, post-ec188d6)
--   173-182       jcs-1 only              (2026-09-02)
--
-- So the date cut is correct as a statement about which rule was in force, and
-- it labels all 17 rows the way an auditor needs them labelled.
UPDATE iterations
   SET canonicalization_profile =
       CASE WHEN timestamp < '2026-07-13' THEN 'insertion-order-1' ELSE 'jcs-1' END
 WHERE workflow_hash IS NOT NULL AND workflow_hash <> '';

-- Rows with no workflow_hash keep NULL, and that is the honest value rather
-- than a default. Migration 046's sentence, reused because it is the same
-- idea: "NULL — the question was never asked." A CAD row or a bare capture
-- never canonicalized a graph, so it has no profile to report, and stamping
-- one would be answering a question nobody put to it.
