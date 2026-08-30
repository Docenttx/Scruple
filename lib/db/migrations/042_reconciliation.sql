-- Migration 042 — reconciliation: the bounded acceptance window, the
-- backfill checkpoint that pays for it, and silence as a recorded
-- transition rather than a thing you have to remember to ask about.
--
-- H-4 §10 C-3 and §4.2. Three things 041 could not have known it needed:
--
--   1. THE WINDOW. 041 was built against §4.2's strict-increase rule.
--      §10 C-3 retires it: §5 says a queued event KEEPS its counter and
--      drains later, so under strict increase a genuinely captured event
--      that drains after a later one is rejected as a replay and lost
--      from the record. Replay defence is component_events' PRIMARY KEY
--      (component_id, counter) — already in 041 — which makes strict
--      increase redundant with it and additionally harmful. So: accept
--      any UNSEEN counter within a bounded window below the high-water
--      mark; refuse beyond it. `acceptance_window_counters` is that
--      bound, per component for the same reason the heartbeat window is.
--
--   2. THE BACKFILL CHECKPOINT. A hash ratchet is one-way. Verifying a
--      counter BELOW the high-water mark cannot walk backwards from the
--      cached key; it must re-derive from IK forward to that counter, at
--      one HMAC per step. For a component at counter 400,000 that is
--      400,000 HMACs for one late event — and worse, MAX_RATCHET_ADVANCE
--      would refuse it outright, so the window would silently stop
--      working past 100,000 events. `window_floor_*` holds K at the
--      window's lower edge, which caps every backfill derivation at
--      `acceptance_window_counters` steps regardless of how long the
--      component has been running. Advancing it costs one extra
--      HKDF-Expand per delivered event.
--
--      IT IS A CACHE, exactly like chain_key_hex, and carries the same
--      custody caveat 041 states: while the BDK sits in an env var it is
--      no weaker than the BDK beside it; once the BDK moves into the HSM
--      a database read yields forgery for the counters it covers.
--      SCRUPLE_RATCHET_CACHE_CHAIN_KEY=0 disables it along with the
--      forward cache, and backfill then costs a from-IK derivation
--      bounded by MAX_RATCHET_ADVANCE. Dropping both columns loses
--      nothing but CPU.
--
--   3. SILENCE AS A TRANSITION. 041 gave silence a predicate
--      (last_seen_at + heartbeat_window_seconds). A predicate answers
--      "is it silent NOW", which is the right source of truth precisely
--      because it cannot go stale — but it cannot answer "when did it go
--      dark, and did anyone ever notice". That is the Kohya failure in
--      its second form: the fact was computable all along and nothing
--      ever computed it. component_silence_events is the durable record,
--      written by an EXPLICITLY INVOKED sweep (scripts/reconcile-sweep.ts)
--      — never by a timer inside the Next.js process, which would make a
--      serverless deployment's evidence depend on which instance happened
--      to be warm.

-- 1. The acceptance window ---------------------------------------------------
-- §10 C-3's bound, in counters, applied BELOW the high-water mark.
-- MAX_RATCHET_ADVANCE bounds the upward direction; this is the downward
-- one. Default 1000: §5's BACKOFF_SCHEDULE retries one event for ~43
-- minutes, and a component that is still producing during that outage
-- must be able to drain the held event when it comes back. 1000 events
-- of head-room covers that with margin while capping a backfill
-- derivation at 1000 ratchet steps — ~15 ms measured (~5.8 us per step),
-- against ~2.3 s to re-derive from the IK for a component at counter
-- 400,000.
ALTER TABLE components ADD COLUMN acceptance_window_counters INTEGER NOT NULL DEFAULT 1000;

-- 2. The backfill checkpoint -------------------------------------------------
-- window_floor_key_hex holds K_{window_floor_counter}, the chain key at
-- the lower edge of the acceptance window. NULL when the floor is 0,
-- because K_0 is the IK and the server derives that from the BDK in two
-- HMACs — storing it would be persisting the component's root for no
-- saving at all.
ALTER TABLE components ADD COLUMN window_floor_counter INTEGER;
ALTER TABLE components ADD COLUMN window_floor_key_hex TEXT;

-- 3. Backfill is visible in the event record ---------------------------------
-- An event that arrived below the high-water mark is a late drain, not an
-- ordinary delivery. Both are evidence; only one of them says the
-- component's transport was interrupted, and a reconciliation view that
-- cannot tell them apart cannot report that.
ALTER TABLE component_events ADD COLUMN backfilled INTEGER NOT NULL DEFAULT 0;

-- 4. Silence transitions -----------------------------------------------------
CREATE TABLE IF NOT EXISTS component_silence_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  component_id   TEXT NOT NULL REFERENCES components(component_id),
  -- The moment silence became true: last_seen_at (or provisioned_at, for
  -- a component that never produced anything at all) plus the window.
  -- Computed, not the time the sweep happened to run — otherwise the
  -- record says more about cron than about the component.
  went_silent_at TEXT NOT NULL,
  -- What it was silent SINCE. NULL means it never witnessed anything,
  -- which is the most complete form of the failure and must not read as
  -- healthy.
  last_seen_at   TEXT,
  heartbeat_window_seconds INTEGER NOT NULL,
  -- Set by a later sweep when the component came back. A silence that
  -- ended is still a silence that happened: resolving must never mean
  -- deleting, the same rule component_counter_gaps follows.
  recovered_at   TEXT,
  observed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- "Is there an open silence for this component" — the sweep's idempotence
-- check, and the reason running it twice does not write two rows.
CREATE INDEX IF NOT EXISTS idx_component_silence_open
  ON component_silence_events(component_id)
  WHERE recovered_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_component_silence_component
  ON component_silence_events(component_id, observed_at DESC);

-- The reconciliation view reads events by component, newest first, and
-- counts backfills. 041 indexed nothing on component_events because the
-- primary key covered every access it had.
CREATE INDEX IF NOT EXISTS idx_component_events_verified
  ON component_events(component_id, verified_at DESC);
