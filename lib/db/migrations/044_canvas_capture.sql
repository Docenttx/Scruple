-- Migration 044 — canvas's capture log, and the correlation state the two
-- canvas processes cannot share in memory.
--
-- WO-10. Two facts canvas was producing and then throwing away.
--
--   1. THAT A CAPTURE HAPPENED AT ALL, AND WHETHER IT LANDED.
--      lib/canvas/witness.ts:155 caught every ingest failure and wrote it
--      to console.error. The user got their image, no leaf was written,
--      and nothing outside a log line knew. Standard §7 forbids dropping
--      a Phase-3 failure silently, and the grade calls this out as worse
--      than most P-item failures: "a hole you can see is evidence, a hole
--      you cannot see is a lie of omission."
--
--      `canvas_capture_log` is the hole you can see. One row per set of
--      bytes that left through the gate, written BEFORE the bytes are
--      delivered, settled afterwards. status says which of four things
--      happened:
--
--        'witnessed'    ingest ran and a leaf exists.
--        'failed'       ingest threw. The bytes went out anyway (see
--                       CANVAS_BASELINE.md §4 for why) and this row is
--                       the durable, retryable, surfaceable record of it.
--        'unwitnessed'  bytes left on a byte-egress route with no pending
--                       workflow to attribute them to and no prior
--                       iteration carrying the same content hash. Not an
--                       error — a NAMED hole, which is the whole point.
--        'refetch'      the same content hash is already on an iterations
--                       row. A thumbnail reload, not a new artifact.
--
--      `mime` NULL means UNDECLARED, never guessed — CANON_SKELETON §5
--      property 1 and migration 043's mime_declared, spelled the same way
--      here. `mime_source` records WHO declared it ('node' | 'frame' |
--      'vendor-config'), because those are not equally strong.
--
--   2. WHICH PROMPT WAS EXECUTING WHEN A BYTE LEFT.
--      services/scruple-capture/src/correlation.ts keeps this in memory
--      because the component is one process. Canvas is two — the Next
--      route handles HTTP and scripts/canvas-ws-proxy.mjs handles WS —
--      and the WS half is the half that sees `executing` /
--      `execution_success`. In-memory correlation is unavailable to
--      canvas by construction, so the correlator's state is persisted on
--      the pending row instead, and the HTTP half reads it.
--
--      `writers_json` is Correlator.writingNodesOf() output: the writing
--      nodes of the graph and their filename prefixes, which is what
--      makes filename-prefix attribution possible instead of the
--      "most recent pending row" timing guess the old code used and did
--      not label.
--
-- Additive only. Every column has a default true of every existing row.

CREATE TABLE IF NOT EXISTS canvas_capture_log (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id         TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  prompt_id          TEXT,
  -- 'network-gate-http' | 'network-gate-ws'. Matches lib/capture/surface.ts
  -- CaptureSurfaceKind plus the leg, because canvas's two legs are two
  -- processes and a row must say which one wrote it.
  surface            TEXT NOT NULL,
  -- The route path, or 'ws:binary:<eventType>' for a WS frame.
  egress             TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  size_bytes         INTEGER NOT NULL,
  mime               TEXT,
  mime_source        TEXT,
  -- 'filename-prefix' | 'ws-executing' | 'most-recent-pending' | 'none'.
  -- The first, second and fourth are services/scruple-capture/src/
  -- correlation.ts's CorrelationMethod, unchanged. The third is the state
  -- only canvas can be in — the WS sidecar is not connected, so nothing said
  -- anything was executing and the only ordering left is insertion order on
  -- the pending table. That IS the pairing the old lib/canvas/witness.ts used
  -- for everything, and correlation.ts's own header says "stating it is the
  -- difference". A verifier is never told a guess was a fact.
  correlation_method TEXT NOT NULL DEFAULT 'none',
  status             TEXT NOT NULL
                       CHECK (status IN ('witnessed','failed','unwitnessed','refetch')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  error              TEXT,
  iteration_id       INTEGER,
  leaf_hash          TEXT,
  witnessed          INTEGER NOT NULL DEFAULT 0,
  leaf_scheme        TEXT,
  observed_at        TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at         TEXT
);

CREATE INDEX IF NOT EXISTS idx_canvas_capture_log_open
  ON canvas_capture_log (status, observed_at);
CREATE INDEX IF NOT EXISTS idx_canvas_capture_log_user
  ON canvas_capture_log (user_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_canvas_capture_log_content
  ON canvas_capture_log (content_hash);

ALTER TABLE canvas_pending_iterations ADD COLUMN writers_json TEXT;
ALTER TABLE canvas_pending_iterations ADD COLUMN executing_at TEXT;
ALTER TABLE canvas_pending_iterations ADD COLUMN finished_at  TEXT;
