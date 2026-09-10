-- Migration 060 — what entered this document from outside, and that nobody
-- here watched it arrive (WO-F3).
--
-- WO-E7 finding E7-1, `docs/STATE.md` §4.7, and it is the finding the E series
-- ends on. Two Blender scenes were built around two DIFFERENT AI images — the
-- same scene, the same camera, the same frame, a different generated image
-- packed inside — and the two leaves the standalone add-on produced were
-- IDENTICAL in every field that could describe how the artifact came to exist:
-- `workflow_hash`, `machine_manifest_hash`, `model_fingerprints`, `input_hash`,
-- `host_semantics`. Only the digest of the pixels moved.
--
-- ⚑ IT IS NOT A FALSE CLAIM, IT IS AN ABSENT ONE, and absence and "there was
-- nothing" read the same. That is the failure mode `blind`/`declined` exists to
-- prevent one layer down (058), arriving in the product `docs/BLENDER.md` names
-- as the one to get right.
--
-- THE PRODUCT DECISION, taken in docs/WORK-ORDERS-F.md WO-F3 and not reopened
-- here. §4.7 listed three honest candidates and this is the second of them:
-- A DECLARED FIELD NAMING THE IMPORTED DATABLOCKS AND THEIR DIGESTS. Not the
-- other two, and the reasons are the point:
--
--   * NOT `host_semantics: blind` (058). `blind` means FULL BYTE COVERAGE AND
--     NO MEANING — a gate saw every byte and could not read them. The
--     standalone add-on has no byte coverage of the AI step at all, so `blind`
--     on that leaf would assert a capture path that does not exist. That is a
--     worse defect than the silence it replaces.
--   * NOT `declared_uncaptured` (059). That set is a closure over what an
--     upstream REPORTED through `/history`. There is no upstream here and
--     nothing reported anything, so the set would carry no scope and 059's own
--     rules would make it read `not_enumerated` forever.
--   * YES to naming the datablocks. Blender KNOWS what was imported: an image
--     packed into a .blend has a datablock, a source path, and bytes that can
--     be hashed. So the leaf can say "these assets entered this scene from
--     outside, here are their digests, and this product did not observe how
--     they were made" — strictly more useful than "something was imported" and
--     exactly as honest.
--
-- ⚑ AND IT COMPOSES, which is the reason it is worth a column rather than a
-- footnote. A Desktop Studio leaf's `output_hash` IS the sha256 of the file
-- ComfyUI wrote; `pack()` stores those same bytes verbatim (measured, not
-- assumed — `scripts/f3-datablock-probe.py` in the desktop repo hashes the file
-- on disk and `packed_file.data` and compares). So an imported datablock's
-- digest MATCHES the witnessed artifact's content hash, and the two products
-- join up on evidence without either of them overclaiming.
--
-- ⚑ FIVE SCALARS AND A DOCUMENT, and the split is 058's and 059's. A datablock
-- list cannot ride in a MAC preimage, so the document is stored beside
-- `host_evidence` and `declared_uncaptured` and only its DIGEST is signed
-- (`imported_datablocks_hash`); the route recomputes the digest from the
-- document and refuses a pair that disagrees, so the unsigned half stays
-- honest.
--
-- ⚑ THE SCALARS ARE TOP-LEVEL SUBMISSION FIELDS, NOT `capture` FIELDS, and
-- that is deliberate rather than convenient. `capture` is what a CAPTURE
-- COMPONENT observed, and `lib/leaf/captureClaims.ts` rightly requires a
-- capture-bearing leaf to declare an attestation basis, a profile, a storage
-- confinement, an upstream epoch and a host level. The standalone add-on is a
-- plugin with no component and no gate: it has none of those to declare, and
-- putting this field inside `capture` would force it to invent all five to say
-- one true thing. So they sit beside `machine_manifest_hash` — top level, in
-- the preimage, read by `componentPreimage()` from the submission root.
--
-- ⚑ AND THE COUNT IS SIGNED SEPARATELY EVEN THOUGH THE DOCUMENT CARRIES IT,
-- for 059's reason exactly: 0 is "the datablocks were enumerated and none came
-- from outside"; NULL is "nothing enumerated them". Different operational
-- conditions, different owners, and CHECK 2 is what stops the second being
-- written where the first belongs.
--
-- NULL IS THE LEGACY VALUE AND IT IS NOT BACKFILLED, for 053's, 056's, 057's,
-- 058's and 059's reason: NULL is "the question was never asked of this leaf";
-- `imported_datablocks_source = 'none'` is "asked, and there was nothing to
-- enumerate".

-- How the set was obtained.
--   'host_datablocks'  the host's own datablock table was enumerated — the
--                      authoritative answer to "what is in this document",
--                      from the application that holds it
--   'none'             no enumeration was performed. A door with no host to
--                      ask (canvas, a bare HTTP submission) says this, and it
--                      is NOT an empty set
ALTER TABLE iterations ADD COLUMN imported_datablocks_source TEXT
  CHECK (imported_datablocks_source IN ('host_datablocks', 'none'));

-- ⚑ WHETHER THE PARTY THAT PRODUCED THIS LEAF WATCHED THESE ASSETS ARRIVE.
-- 0 is the whole point of the field: "these bytes came from outside and nobody
-- here saw how they were made". It is a COLUMN and not prose because the
-- alternative — an absent field — is what E7-1 measured, and because it must
-- be inside the MAC: a party in the middle who could promote 0 to 1 would turn
-- "nobody looked" into "somebody watched", which is the measured-or-unknown
-- invariant applied to provenance instead of to coverage.
--
-- 1 IS REFUSED BY THE VALIDATOR TODAY, and that refusal is POLICY, not schema.
-- `lib/capture/importedDatablocks.ts` carries the named blocker so the day a
-- door genuinely observes an import the value moves without a migration. The
-- CHECK admits both because the column has to be able to hold the answer.
ALTER TABLE iterations ADD COLUMN imported_origin_observed INTEGER
  CHECK (imported_origin_observed IN (0, 1));

ALTER TABLE iterations ADD COLUMN imported_datablocks_hash TEXT;

-- How many of the declared datablocks could NOT be read, and therefore have no
-- digest. ⚑ RECORDED RATHER THAN OMITTED: a datablock whose bytes are gone is
-- still a fact about what this document references, and dropping it from the
-- list would make an unreadable import indistinguishable from no import. WO-D3's
-- rule, one field over: the refusal keeps the member, it only refuses the claim.
ALTER TABLE iterations ADD COLUMN imported_datablocks_unreadable_count INTEGER;

-- The canonical bytes that were hashed, not a re-serialisation of them, so a
-- verifier holding this column can reproduce `imported_datablocks_hash`
-- directly. Same correction `model_fingerprints`, `host_evidence` and
-- `declared_uncaptured` carry.
ALTER TABLE iterations ADD COLUMN imported_datablocks TEXT;

-- ⚑ THE CROSS-COLUMN CHECKS ARE THE POINT, exactly as in 053, 056, 057, 058
-- and 059. Three guards say the same thing and none is the same guard twice:
-- the types in lib/capture/importedDatablocks.ts stop the code being written,
-- its validator stops the JSON arriving — types do not survive a wire — and
-- this stops any other writer, present or future, that reaches the table
-- through neither.
--
--   1. NOTHING ENUMERATED MEANS NOTHING COUNTED, NOTHING HASHED AND NOBODY
--      ASKED ABOUT ORIGIN. A 'none' row carrying a list is a claim about a set
--      nobody built.
--   2. ⚑ AN ENUMERATED SOURCE ALWAYS HAS A COUNT, AND 0 IS A COUNT. This is
--      "the empty declaration is present, not absent" in SQL. Without it the
--      two states the field exists to distinguish — "looked and nothing came
--      from outside" and "nothing looked" — are one NULL.
--   3. AN ENUMERATED SOURCE ALWAYS ANSWERS THE ORIGIN QUESTION. A list of
--      digests with no statement about whether anyone watched them arrive is
--      the silence E7-1 found, wearing a digest.
--   4. A NON-EMPTY SET NEEDS ITS DOCUMENT. A count above zero with no stored
--      document is a cardinality nobody can read the members of.
--   5. THE UNREADABLE COUNT IS A SUBSET OF THE COUNT, and it exists exactly
--      when the count does.
--
-- Existing rows are unaffected: every comparison against NULL evaluates to
-- NULL, which a CHECK admits.
ALTER TABLE iterations ADD COLUMN imported_datablocks_count INTEGER
  CHECK (
    (imported_datablocks_count IS NULL OR imported_datablocks_count >= 0)
    AND NOT (
      imported_datablocks_source = 'none'
      AND (imported_datablocks_count IS NOT NULL
           OR imported_datablocks_hash IS NOT NULL
           OR imported_datablocks IS NOT NULL
           OR imported_origin_observed IS NOT NULL
           OR imported_datablocks_unreadable_count IS NOT NULL)
    )
    AND NOT (
      imported_datablocks_source = 'host_datablocks'
      AND (imported_datablocks_count IS NULL OR imported_datablocks_hash IS NULL)
    )
    AND NOT (
      imported_datablocks_source = 'host_datablocks'
      AND imported_origin_observed IS NULL
    )
    AND NOT (imported_datablocks_count > 0 AND imported_datablocks IS NULL)
    AND NOT (
      imported_datablocks_unreadable_count IS NOT NULL
      AND (imported_datablocks_count IS NULL
           OR imported_datablocks_unreadable_count < 0
           OR imported_datablocks_unreadable_count > imported_datablocks_count)
    )
    AND NOT (
      imported_datablocks_count IS NOT NULL
      AND imported_datablocks_unreadable_count IS NULL
    )
  );

-- "Show me every leaf that declared an import nobody watched arrive" and "show
-- me every leaf that named a datablock it could not read" are the two queries
-- an auditor runs after a provenance question is raised — and the third is the
-- JOIN that makes this field worth having: given a witnessed artifact's content
-- hash, which documents imported it. That one runs against the document, so it
-- is a LIKE over `imported_datablocks`; the index below at least keeps the
-- candidate set to the leaves that declared anything at all.
CREATE INDEX IF NOT EXISTS idx_iterations_imported_datablocks_count
  ON iterations(imported_datablocks_count) WHERE imported_datablocks_count > 0;
CREATE INDEX IF NOT EXISTS idx_iterations_imported_origin_observed
  ON iterations(imported_origin_observed) WHERE imported_origin_observed IS NOT NULL;
