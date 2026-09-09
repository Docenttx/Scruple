-- Migration 056 — where the ratchet's state lives, measured per leaf (WO-C4).
--
-- IT Expert's finding, confirmed by the council in the code: `stateDir` holds
-- the sealed IK, the ratchet counter and the durable queue; the watched
-- volumes are where an uncaptured tenant write lands; and NOTHING requires
-- them to be on different filesystems. The chain that follows —
--
--   an uncaptured runaway write exhausts blocks on a shared filesystem
--     → the ratchet's local append cannot fsync()
--     → and the MAC is the BLOCKING half of emit()
--     → fail-closed becomes FAIL-STOPPED, triggered by the very artifact
--       class the gate cannot see.
--
-- Two columns, because the value and whether anything measured it are two
-- facts. Every asserted field in this design carries exactly `source:
-- measured` or `source: unknown`; configuration, inheritance, prior
-- certification and defaults cannot populate a fact.
--
-- FOUR VALUES AND NOT TWO. The council named one degraded tag because it was
-- arguing about one mechanism. There are two ways to starve the append, they
-- have different fixes, and this series has already refused to fold two
-- operational conditions into one value once — WO-C1 kept `stale` out of
-- `passthrough` on exactly that ground.
--
--   'confined'                 state on its own device, above the floor
--   'degraded_shared_storage'  state shares a device with a watched volume
--   'degraded_no_reservation'  own device, but below the reservable floor
--   'unknown'                  a reading failed, or the placement has no
--                              watched volume to compare against
--
-- NULL IS THE LEGACY VALUE AND IT IS NOT BACKFILLED, for migration 053's
-- reason: every row written before this migration was written without the
-- question being asked, and 'unknown' would manufacture an answer nobody
-- gave. NULL means never asked; 'unknown' means asked and unanswerable.

ALTER TABLE iterations ADD COLUMN storage_confinement TEXT
  CHECK (storage_confinement IN
    ('confined', 'degraded_shared_storage', 'degraded_no_reservation', 'unknown'));

-- ⚑ THE CROSS-COLUMN CHECK IS THE POINT, exactly as in 053. A substantive
-- confinement value with no measurement behind it is a claim about a
-- filesystem that nobody looked at, and `unknown` with `measured` is a
-- measurement whose conclusion is that nothing was measured. Three guards say
-- this: the type in lib/capture/storageConfinement.ts stops the code being
-- written, lib/leaf/captureClaims.ts rule 5 stops the JSON arriving — types do
-- not survive a wire — and this stops any other writer, present or future,
-- that reaches the table through neither.
--
-- Existing rows are unaffected: `NOT (NULL = 'confined' AND NULL <>
-- 'measured')` evaluates to NULL, which a CHECK admits.
ALTER TABLE iterations ADD COLUMN storage_confinement_source TEXT
  CHECK (
    storage_confinement_source IN ('measured', 'unknown')
    AND NOT (storage_confinement <> 'unknown' AND storage_confinement_source <> 'measured')
    AND NOT (storage_confinement = 'unknown' AND storage_confinement_source = 'measured')
  );

-- A degraded session is meant to be findable. Without this, "show me every
-- leaf produced while the ratchet could be starved" is a table scan over every
-- leaf the estate holds, which is the kind of query an auditor stops running.
CREATE INDEX IF NOT EXISTS idx_iterations_storage_confinement
  ON iterations(storage_confinement);
