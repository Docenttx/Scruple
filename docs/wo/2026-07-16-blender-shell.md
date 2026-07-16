# WO-BLENDER — Scruple for Blender (overnight, autonomous)

## Status
- **Started:** TBD (awaits go-ahead)
- **Owner:** claude (autonomous overnight)
- **Target end state:** installable `.zip` addon that the user can drag-drop into Blender the next morning and smoke against production `witness.scruple.ai`. All logic that does not require a live Blender instance is complete and tested against a mock-bpy harness.

## What's in vs. out of overnight scope

**In (fully doable without the user):**
- Full addon Python code, tests, packaging.
- All Scruple server integration (reuse `scruple-web` endpoints untouched).
- Mock-Blender harness patterned on `/data/scruple-fusion/lib/fusion_mocks.py`.
- Install `.zip` + install docs + developer docs.
- Repo `/data/scruple-blender/` seeded, committed, pushed to a fresh GitHub repo under `Docenttx`.

**Out (requires user, deferred to morning):**
- Actual smoke inside real Blender.
- Blender Extensions catalog submission (needs Blender Foundation account).
- Gumroad / Blender Market listing (needs user account + license key generation).
- Any 3DS-required payment tests (needs user's real card).

## Reference patterns (reused, not rewritten)

- `/data/scruple-fusion/ScrupleFusion.py` — auth handshake, URL scheme callback server, session=latest fallback, disk-cached auth, project follow, action bridge.
- `/data/scruple-fusion/lib/scruple_client.py` — HTTP client to scruple-web.
- `/data/scruple-fusion/lib/witness.py` — leaf construction, POST to Witness API.
- `/data/scruple-fusion/lib/lock_flow.py` — lock/checkpoint/chain-lock orchestration.
- `/data/scruple-fusion/lib/fusion_mocks.py` — how to mock a proprietary host API for pytest. Direct port pattern.

## Blender API surface (research-first, then code)

- Target **Blender 4.2 LTS+** (Python 3.11, Extensions system with `blender_manifest.toml`).
- Ship a `bl_info` fallback so Blender 3.x/4.0/4.1 users can install as a classic addon.
- Event hooks in scope:
  - `bpy.app.handlers.render_complete` — every render finish (still + animation).
  - `bpy.app.handlers.render_write` — per-frame during animation.
  - `bpy.app.handlers.save_post` — every `.blend` save.
  - Export operators (`bpy.ops.export_scene.*`, `bpy.ops.export_mesh.*`) — wrapped via `bpy.app.handlers` post-hook where available; otherwise via operator override for the common export types (glTF, FBX, OBJ, USD).

## Phase map

### Phase 0 — Discovery + skeleton (research pass, no user-visible artefacts)

- [ ] Fetch `docs.blender.com/api/current/` — enumerate every relevant `bpy.app.handlers`, `AddonPreferences`, `Operator`, `Panel`, `PropertyGroup` pattern.
- [ ] Read `/data/scruple-fusion/` end-to-end. Enumerate every pattern that transplants (auth, client, witness, lock, mocks, tests).
- [ ] Create `/data/scruple-blender/` with skeleton: `__init__.py`, `blender_manifest.toml`, `lib/`, `panels/`, `operators/`, `tests/`, `build/`, `docs/`, `.gitignore`, `README.md`.
- [ ] Initialise fresh git repo. First commit: skeleton only.

### Phase 1 — Auth + config

- [ ] `lib/auth.py` — port Fusion's URL-scheme handshake:
  - `scruple://blender-auth?key=…` deep-link handler.
  - Local `http://127.0.0.1:PORT/callback` fallback for Linux where URL schemes are unreliable.
  - Disk cache at `~/.scruple/blender-auth.json` (permissions 0600).
- [ ] `lib/preferences.py` — `bpy.types.AddonPreferences` with:
  - API base URL (default `https://scruple.ai`).
  - Payment status ("Set up on scruple.ai" button, opens browser).
  - Manual key entry fallback.
- [ ] Test: unit tests for auth round-trip against a mocked HTTP server.

### Phase 2 — Client library

- [ ] `lib/scruple_client.py` — thin HTTP wrapper. Port from Fusion's client:
  - `GET /api/projects`, `POST /api/projects`, `GET /api/projects/:id`.
  - `POST /api/v1/log` (Witness ingest).
  - `POST /api/lock/checkpoint`, `POST /api/lock/local`, `POST /api/lock/chain`.
  - `GET /api/stripe/config`, `GET /api/stripe/payment-methods`, `POST /api/stripe/payment-intent`, `POST /api/stripe/confirm`.
- [ ] Uses `requests` from Blender's bundled Python. No external installs.
- [ ] Test: unit tests against a mocked scruple-web via `responses` library.

### Phase 3 — Output capture + hashing

- [ ] `lib/capture.py` — capture pipeline:
  - Post-render: read the output path from `bpy.context.scene.render.filepath`, hash with SHA-256, extract render settings (resolution, samples, engine, camera, seed if random).
  - Post-save: hash the saved `.blend` file, extract scene inventory (object count, material count, texture inventory with hashes).
  - Post-export (glTF, FBX, OBJ, USD): hash the exported file, extract format-specific metadata.
- [ ] `lib/manifest.py` — construct a canonical leaf preimage per the Scruple v2.4 leaf schema (mirror `/data/scruple-fusion/lib/witness.py`). Includes `output_hash`, `input_hash` (source `.blend`), `workflow_hash` (canonical serialisation of relevant scene props), `machine_manifest_hash` (Blender version + addon inventory).
- [ ] Test: golden-vector tests against fixed fixture files.

### Phase 4 — Handler wiring

- [ ] `lib/handlers.py` — register on addon enable, unregister on disable:
  - `bpy.app.handlers.render_complete.append(_on_render_complete)`
  - `bpy.app.handlers.render_write.append(_on_render_write)` (animation per-frame)
  - `bpy.app.handlers.save_post.append(_on_save_post)`
  - Export operator wrappers for glTF/FBX/OBJ/USD via `bpy.types.Operator` subclassing + register/unregister.
- [ ] Each handler dispatches to `lib/capture.py` on a background thread (Blender's UI must not block).
- [ ] Test: handler registration + dispatch verified via mock bpy.

### Phase 5 — Operators + panels

- [ ] `operators/witness.py` — `scruple.witness_now` operator: manual re-witness of current output.
- [ ] `operators/checkpoint.py` — `scruple.checkpoint` operator: paid action, checks PM on file, calls `/api/lock/checkpoint`.
- [ ] `operators/c2pa.py` — `scruple.c2pa_sign` operator: paid, calls `/api/lock/local` with C2PA flag.
- [ ] `operators/chain_lock.py` — `scruple.chain_lock` operator: paid, calls `/api/lock/chain`.
- [ ] `operators/open_receipt.py` — opens the current project's receipt page in system browser.
- [ ] `panels/main.py` — N-panel in the 3D Viewport sidebar:
  - "Scruple" tab.
  - Current project name + status badge.
  - Buttons: `Witness Now`, `Checkpoint · $5`, `C2PA · $10`, `Chain-lock · $100`.
  - Price labels only shown if PM is on file; otherwise CTA "Set up payment method on scruple.ai".
  - Recent receipts list (last 5) with click-to-open.
- [ ] `panels/preferences.py` — the addon-prefs UI: auth status, payment status, base URL, log-verbosity toggle.

### Phase 6 — Payment flow (metered off-session)

- [ ] Payment setup happens on scruple.ai, not inside Blender (Blender UI is native, no HTML — no Elements). Preferences pane has a button that opens `https://scruple.ai/settings/payment` in the system browser.
- [ ] Every paid operator:
  1. `GET /api/stripe/payment-methods` to confirm PM on file.
  2. Show a modal confirmation ("Charge $5 to card ending 4242?") via `bpy.ops.wm.invoke_confirm`.
  3. `POST /api/stripe/payment-intent` with `{action, projectId}`, `off_session: true`, `confirm: true`. Server charges and returns `pi_XXX` on success.
  4. `POST /api/lock/…` with the `pi_XXX`.
- [ ] Any `requires_action` from Stripe → operator shows a message "This card needs verification — please complete on scruple.ai/pay/<pi>" and opens the URL. When user finishes, the URL-scheme callback (`scruple://payment-complete?pi=…`) resumes the pending operator.

### Phase 7 — Mock Blender harness + tests

- [ ] `tests/mocks/bpy_mock.py` — minimal bpy surface for pytest:
  - `bpy.app.handlers.render_complete` as a callable list.
  - `bpy.context.scene.render.filepath`.
  - `bpy.types.Operator`, `Panel`, `AddonPreferences` as base classes with `register/unregister` no-ops.
  - `bpy.ops.wm.invoke_confirm` returns configurable result.
- [ ] `tests/conftest.py` — inserts `mocks/bpy_mock.py` on `sys.path` before any addon import.
- [ ] Unit tests for: hash correctness, manifest canonicalisation, client requests, handler dispatch, operator flows, prefs persistence.
- [ ] Integration tests against a locally-run scruple-web (Next.js dev server), using seeded test fixtures.

### Phase 8 — Packaging

- [ ] `build/build_addon.sh` — produces `dist/scruple-blender-<version>.zip` matching Blender Extensions format:
  - Extensions manifest (`blender_manifest.toml`) for 4.2+.
  - `bl_info` fallback in `__init__.py` for 4.0/4.1.
  - Wheel-vendored dependencies (only pure-Python; Blender's `requests` is available bundled, but we vendor `responses` for tests only, not shipped).
- [ ] `build/build_addon.sh --publish` — dry-run of Blender Extensions submission (real submit deferred; requires user's Blender ID).

### Phase 9 — Docs

- [ ] `docs/install-quickstart.md` — drag-drop install, first-run auth, payment setup.
- [ ] `docs/architecture.md` — brief WHAT-not-HOW; note that Blender's handler system means Scruple runs entirely in-process without a webview.
- [ ] `docs/developer.md` — repo layout, test running, packaging, contribution guide.
- [ ] `README.md` — top-level overview + install badge + supported Blender versions.

### Phase 10 — Session report + memory + commit sweep

- [ ] Commit sweep across `/data/scruple-blender/` on `main`. Push to `github.com/Docenttx/scruple-blender` (create repo via `gh` CLI).
- [ ] Also commit the WO progress in `/data/scruple-web/docs/wo/` if any adjustments made.
- [ ] Session report at `/data/scruple-blender/SESSION_REPORT_2026-07-17.md` with: what shipped, what's ready for user smoke, exact install steps, known gaps.
- [ ] New memory `project_scruple_blender_shell_shipped_2026_07_17.md` linking back to the WO.
- [ ] Update `STATE.md` in `/data/ai-council/ai-council/memory/`.

## Morning handoff (what the user does)

1. `gh repo view Docenttx/scruple-blender` to confirm repo present.
2. Download `dist/scruple-blender-<version>.zip`.
3. Blender → Edit → Preferences → Add-ons → Install from Disk → pick the zip.
4. Enable "Scruple". Preferences pane appears.
5. Click "Sign in" → browser opens → auth completes → return to Blender.
6. Click "Set up payment" → browser opens `scruple.ai/settings/payment` → user adds card via existing scruple-web flow.
7. Open a `.blend` (or start fresh), render, verify the Scruple N-panel shows the render as a new project with a Witness leaf.
8. Click `Checkpoint · $5` — confirms charge, receipt appears, sidebar updates.
9. Click `C2PA · $10` — same. Downloads C2PA-signed export.
10. Click `Chain-lock · $100` — same. Ledger anchor lands.

Any deviation from that flow is a bug in the shell — report location, expected/actual, and next-day fix window is short.

## Non-goals

- Distribution submission (Blender Extensions catalog, Gumroad, Blender Market) — needs user.
- In-Blender payment card entry — impossible without a webview; browser handoff is the correct pattern.
- 3DS card testing — user's live card required.
- License-key gate (that's the download-license flow, handled elsewhere).

## Effort estimate

Autonomous execution: **~5–8 hours** end-to-end for phases 0–10. Fits inside one overnight window with margin.

Recovery budget: if any single phase blows past 90 minutes, log the blocker, ship what works, note in the session report as morning-user-action-required, move on.

## Go/no-go signal

User confirms with a single word ("go" / "hold") and I begin execution. No further check-ins until the morning session report unless a hard blocker requires an override decision.
