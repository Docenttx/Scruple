-- Migration 057 — which upstream run produced this leaf (WO-C5).
--
-- The council owned this one rather than pushing it into the schema. Hand
-- round 6 §2, verbatim:
--
--   "Nothing in the component tracks upstream identity — no call to
--   /system_stats, no upstream id, no version pin ... WE NEVER ASK COMFYUI WHO
--   IT IS. So IT Expert is right on both counts: a silent ComfyUI restart is
--   invisible to us today, and it is a change to our component rather than to
--   your schema."
--
-- And the fact that makes it matter, verified in the ComfyUI source for round
-- 5 §4(b): `execution.py:1186` sets MAXIMUM_HISTORY_SIZE = 10000, `task_done`
-- evicts the oldest past it, and `self.history` is an in-memory dict on
-- `PromptQueue` — IT DOES NOT SURVIVE A RESTART. An absence set drawn from it
-- after a restart asserts that artifacts never existed when the enumeration
-- was merely lost.
--
-- ⚑ TWO IDENTITIES, TWO COLUMNS, AND THEY ARE NOT THE SAME FACT.
-- `upstream_identity` is digested from /system_stats (server.py:646-685) and
-- says WHICH INSTALL answered. It carries no boot id, no pid and no start
-- time, so it is BYTE-IDENTICAL ACROSS A RESTART and is not a restart signal.
-- `upstream_epoch` is derived from the volatile /history ring and says WHICH
-- RUN answered. Storing them in one column, or reading either as the other,
-- reintroduces exactly the blind spot this migration exists to close.
--
-- ⚑ BOTH LOW WATERMARKS, because Architect asked for "the low watermark at
-- BOTH query ends" and one number cannot carry it. `/history` is paged and
-- non-atomic (server.py:888-900 → execution.py:1282) and `task_done` can evict
-- between pages, so an enumeration bracketed by one reading cannot tell "these
-- entries were never there" from "these entries left while I was reading".
--
-- NULL IS THE LEGACY VALUE AND IT IS NOT BACKFILLED, for 053's and 056's
-- reason: NULL is "the question was never asked of this leaf"; 'not_queried'
-- is "asked, and there was nothing to ask". Defaulting the first into the
-- second would manufacture an answer nobody gave.

ALTER TABLE iterations ADD COLUMN upstream_identity TEXT;
ALTER TABLE iterations ADD COLUMN upstream_epoch TEXT;

ALTER TABLE iterations ADD COLUMN upstream_continuity TEXT
  CHECK (upstream_continuity IN ('continuous', 'restarted', 'unknown'));

ALTER TABLE iterations ADD COLUMN upstream_low_watermark_open INTEGER;
ALTER TABLE iterations ADD COLUMN upstream_low_watermark_close INTEGER;

ALTER TABLE iterations ADD COLUMN upstream_uncaptured_reason TEXT
  CHECK (upstream_uncaptured_reason IN
    ('enumerated', 'evicted_or_restarted', 'interval_not_covered',
     'history_unavailable', 'not_queried'));

-- ⚑ THE CROSS-COLUMN CHECKS ARE THE POINT, exactly as in 053 and 056. Three
-- guards say the same thing and none of them is the same guard twice: the
-- types in lib/capture/upstreamEpoch.ts stop the code being written,
-- lib/leaf/captureClaims.ts rule 6 stops the JSON arriving — types do not
-- survive a wire — and this stops any other writer, present or future, that
-- reaches the table through neither.
--
--   1. A SUBSTANTIVE CONTINUITY NEEDS A MEASUREMENT. `continuous` unmeasured
--      claims a continuity nobody established; `restarted` unmeasured is an
--      alarm nobody rang.
--   2. AN UNMEASURED SOURCE MAY ONLY CARRY A REASON THAT DESCRIBES NOT HAVING
--      A MEASUREMENT. This is Architect's condition in SQL: the recoverable,
--      bounded, detectable case ('evicted_or_restarted') must not be able to
--      wear the unmeasured case's clothes, "otherwise the volatile source
--      degrades to unknown for both the recoverable and unrecoverable cases
--      and you lose the only signal that would tell an operator to shorten
--      their query interval."
--   3. `not_queried` CANNOT HAVE PINNED AN EPOCH. Nobody asked; an epoch is
--      pinned from a retained prompt.
--
-- ⚑ AND NOTE WHAT IS *NOT* REFUSED: `upstream_continuity = 'unknown'` WITH
-- `upstream_source = 'measured'`. Migration 056 refuses the analogous pair for
-- storage, and the difference is deliberate rather than an oversight. A
-- storage `unknown` means the stat failed, so no measurement exists. An
-- upstream `unknown` is frequently the CONCLUSION OF one: an idle history at
-- both ends of an interval genuinely cannot distinguish a restart from a quiet
-- afternoon, and a component that looked and found that out is telling the
-- truth. Refusing it here would force such a component to lie in one of two
-- directions, and the lie in the `continuous` direction is the exact defect
-- this work order closes.
--
-- Existing rows are unaffected: every comparison against NULL evaluates to
-- NULL, which a CHECK admits.
ALTER TABLE iterations ADD COLUMN upstream_source TEXT
  CHECK (
    upstream_source IN ('measured', 'unknown')
    AND NOT (upstream_continuity <> 'unknown' AND upstream_source <> 'measured')
    AND NOT (
      upstream_source = 'unknown'
      AND upstream_uncaptured_reason NOT IN ('not_queried', 'history_unavailable')
    )
    AND NOT (upstream_uncaptured_reason = 'not_queried' AND upstream_epoch IS NOT NULL)
  );

-- "Show me every leaf produced by a run that did not survive" and "show me
-- every leaf whose absence set is not a closure" are the two queries an
-- auditor runs after a restart is reported. Without these both are a table
-- scan over every leaf the estate holds, which is the kind of query an auditor
-- stops running.
CREATE INDEX IF NOT EXISTS idx_iterations_upstream_epoch
  ON iterations(upstream_epoch) WHERE upstream_epoch IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_iterations_upstream_continuity
  ON iterations(upstream_continuity) WHERE upstream_continuity IS NOT NULL;
