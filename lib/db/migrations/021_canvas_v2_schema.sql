-- Migration 021: Canvas v2 schema — per-user machines, machine_versions,
-- leaf v2.2 columns, publication mode.
--
-- WO docs/wo/2026-06-22-v2-03-schema-021.md.
-- Spec docs/architecture/canvas-v2.md decisions 3, 5, 6.
--
-- Pure additive — no destructive changes. Default machine row seeded
-- inline; manifest_hash matches lib/canvas/manifest.ts canonical sha256.

-- ── machines ──────────────────────────────────────────────────────────
-- Per-user (or shared default) Modal images. user_id NULL = shared.
CREATE TABLE machines (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  label TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  build_status TEXT NOT NULL DEFAULT 'pending',
  build_error TEXT,
  modal_image_digest TEXT,
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  archived_at INTEGER
);
CREATE INDEX idx_machines_user ON machines(user_id);
CREATE INDEX idx_machines_hash ON machines(manifest_hash);

-- ── machine_versions ─────────────────────────────────────────────────
-- Audit trail — when a user edits a manifest, a NEW machines row is
-- created (so iteration history can resolve to the version that ran
-- it) AND a machine_versions row records the change.
CREATE TABLE machine_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);
CREATE INDEX idx_mv_machine ON machine_versions(machine_id);

-- ── iterations: leaf v2.2 fields + publication mode ──────────────────
-- iterations.leaf_scheme already exists (migration 016, default 'v1';
-- existing rows are 'v1' or 'v2'). The WO-8 ingestIteration update
-- will set 'v2.2' for new rows; the audit script dispatches on actual
-- value. No schema change here.
ALTER TABLE iterations ADD COLUMN machine_manifest_hash TEXT;
ALTER TABLE iterations ADD COLUMN workflow_publication TEXT NOT NULL DEFAULT 'full';

-- The witness "server" lives in /opt/scruple-witness/ (separate process,
-- writes its own log); no `witnesses` table in this DB. WO-8 updates the
-- witness server's canonical record to include machine_manifest_hash.

-- ── seed: shared default machine ─────────────────────────────────────
-- manifest_json = canonical form of config/default-machine-manifest.json
-- (keys sorted recursively; arrays preserve order).
-- manifest_hash = sha256(manifest_json) hex.
-- build_status = 'pending' — the build worker (WO-7) resolves
-- commit_sha values + builds the image + flips to 'ready'.
INSERT INTO machines (
  id, user_id, label, manifest_json, manifest_hash,
  build_status, created_at
) VALUES (
  'default-scruple-canvas-v1',
  NULL,
  'Default Scruple Canvas v1',
  '{"comfyui_version":"v0.18.5","custom_nodes":[{"commit_sha":null,"pack":"easy-use","ref":"v1.3.6","repo":"yolain/ComfyUI-Easy-Use"},{"commit_sha":null,"pack":"videohelpersuite","ref":"v1.7.9","repo":"Kosinkadink/ComfyUI-VideoHelperSuite"},{"commit_sha":null,"pack":"advanced-controlnet","ref":"main","repo":"Kosinkadink/ComfyUI-Advanced-ControlNet"},{"commit_sha":null,"pack":"ipadapter-plus","ref":"main","repo":"cubiq/ComfyUI_IPAdapter_plus"},{"commit_sha":null,"pack":"animatediff-evolved","ref":"main","repo":"Kosinkadink/ComfyUI-AnimateDiff-Evolved"},{"commit_sha":null,"pack":"seedvr2","ref":"v2.5.22","repo":"numz/ComfyUI-SeedVR2_VideoUpscaler"}]}',
  '273df1412170d94b0b64f1ce5f6c1f562802cc3cbdcbb4e1bcad67d2ea72b375',
  'pending',
  unixepoch()
);
