# WO-TOONBOOM — Scruple for Toon Boom Harmony (JavaScript scripting)

## Status
- **Started:** TBD
- **Owner:** claude (autonomous overnight)
- **Prereq:** none for build. User provides a Harmony license for the morning smoke.
- **Target end state:** installable script bundle (folder + a couple of `.js` files) the user drops into
  `~/Toon Boom Animation/Toon Boom Harmony ...-scripts/` (or the equivalent per-OS path) and
  restarts Harmony. Scruple menu + toolbar appear, save/export/render events are wired, tests pass
  under a mock-Qt-Script harness.

## Why this target

- HIGH regulatory pull: EU AI Act Article 50(2)/(4) direct hit for AI-assisted animation deliverables,
  DSA cascade to streamers, Canadian C-11 CanCon classification, Canadian Bill C-27 / AIDA on the way.
- Toon Boom Animation is a Canadian company (Montreal). Alignment.
- Open scripting door — no vendor approval, no marketplace review, script bundles install by
  filesystem drop.
- Existing community library **OpenHarmony** (https://github.com/cfourney/OpenHarmony) smooths
  the rougher edges of Harmony's native Qt-Script API; we sit on top of it, not around it.

## What's in vs. out of overnight scope

**In (fully doable without the user):**
- Script bundle skeleton (menu items, toolbar buttons, event handlers).
- Auth handshake with scruple.ai + local HTTP callback fallback (port from Blender addon's `lib/auth.py`).
- HTTP client to scruple-web endpoints (port from Fusion `lib/scruple_client.py` and Blender
  `lib/scruple_client.py`).
- Output capture: hash the exported movie / rendered frames / saved .xstage file.
- Canonical leaf construction per Scruple v2.4 (identical bytes to the Fusion + Blender clients).
- Mock-Harmony test harness (fake `scene`, `MessageLog`, `SceneChangeNotifier`, `Timeline`
  APIs) so tests run under Node.js/pytest.
- Install docs + packaging.

**Out (deferred to morning or later):**
- Live smoke inside real Toon Boom Harmony (requires user's licensed install).
- Payment collection in-panel — Harmony script UI (`ScriptModule` + Qt widgets) is native, not
  HTML. Same off-session pattern as Blender: browser handoff to scruple.ai for card setup,
  then metered per-action.
- Distribution via a marketplace — there isn't one; filesystem drop is the ecosystem norm.

## Reference patterns (reused, not rewritten)

- `/data/scruple-blender/lib/auth.py` — deep-link + local callback pattern, port to Qt-Script XHR.
- `/data/scruple-blender/lib/scruple_client.py` — HTTP wrapper for scruple-web APIs.
- `/data/scruple-blender/lib/witness_flow.py`, `manifest.py` — canonical leaf construction and
  witness POST orchestration.
- `/data/scruple-blender/tests/mocks/bpy_mock.py` + `tests/conftest.py` — mock-host pattern to
  clone for Harmony.
- `/data/scruple-fusion/lib/queue_store.py` — offline retry queue with exponential backoff;
  port unchanged (Qt-Script has enough JS to run this as-is).

## Toon Boom Harmony surface (research-first, then code)

- Target **Harmony Premium 21+** (Qt Script / ECMAScript, Node's `os`/`process` not available;
  use Harmony's own `about`, `System`, `MessageLog`, `preferences`).
- Script types: **Scene scripts** (per-project) and **Application scripts** (global).
  Ship an Application script so the addon survives project switches.
- Event surfaces in scope:
  - `SceneChangeNotifier.onSceneChanged` — project switch.
  - `scene.saveScene()` overridable via `SceneEvent` listener — treat as a save event.
  - Render/export completion — Harmony fires `Application.onFinishedExport` (name varies by
    Harmony version; verify in Phase 0). Confirm and hook per version.
  - Toolbar/menu registration via `ScriptManager.addFunctionToScriptToolbar()` (per Harmony
    API doc).
- UI: prefer `ScriptModule` with Qt widgets (native) for panels; menu items via
  `Application.getMenu("Scripts")` and add submenu.

## Phase map

### Phase 0 — Discovery + skeleton

- [ ] Fetch Toon Boom Scripting docs (`docs.toonboom.com`) and enumerate the exact API names
      per Harmony 21/22/24. Freeze target = Harmony 21 minimum (widest install base).
- [ ] Read OpenHarmony source at `github.com/cfourney/OpenHarmony`. Note which of its wrappers
      simplify our event hooks; wire them in as a git subtree.
- [ ] Create `/data/scruple-toonboom/` with: `Scruple/` (the bundle dir Harmony expects),
      `Scruple/scruple.js` (entry), `Scruple/lib/` (auth, client, capture, manifest, witness_flow,
      queue_store), `Scruple/ui/` (panels, toolbar), `Scruple/vendor/openHarmony/`, `tests/`,
      `build/`, `docs/`.
- [ ] Initialise git repo. First commit: skeleton + vendored OpenHarmony.

### Phase 1 — Auth + prefs

- [ ] `lib/auth.js` — deep-link + local HTTP callback handshake. Auth token cached in
      `preferences.getString("scruple.token", "")` or on disk at `~/.scruple/toonboom-auth.json`
      (permissions 0600).
- [ ] `ui/preferences.js` — a "Scruple Settings" dialog: base URL, auth status, "Set up payment
      on scruple.ai" button that opens the system browser.
- [ ] Test: auth round-trip against a mocked HTTP endpoint.

### Phase 2 — Client library

- [ ] `lib/scruple_client.js` — HTTP wrapper. Uses Harmony's `WebSocketRequest` /
      `QNetworkAccessManager` bridge; if unavailable, fall back to shelling to `curl` via
      `System.system`.
- [ ] Endpoints covered: projects (list, get, create), witness (`/api/witness/cad` equivalent
      for Harmony), stripe/* (customer, payment-methods, payment-intent), lock/* (checkpoint,
      local, chain).
- [ ] Test: mocked responses via a stub `System.system` and `QNetworkAccessManager`.

### Phase 3 — Output capture + hashing

- [ ] `lib/capture.js` — on save: hash `.xstage` and referenced asset files (per-drawing PSDs,
      per-scene audio, palette files). On export/render finish: hash the output movie or image
      sequence.
- [ ] `lib/manifest.js` — canonical leaf preimage matching Scruple v2.4. Fields: output_hash,
      input_hash (scene state), workflow_hash (scene node graph canonicalised), machine_manifest_hash
      (Harmony version + installed script bundles).
- [ ] Test: golden-vector against fixed fixture scenes.

### Phase 4 — Event wiring

- [ ] `lib/handlers.js` — register on script load:
      - Scene save listener.
      - Export/render completion listener (name confirmed in Phase 0).
      - Scene change (project switch).
- [ ] Each dispatches to `lib/capture.js` on Harmony's background timer so the UI doesn't freeze.
- [ ] Test: dispatch verified via mock-Harmony.

### Phase 5 — Menu + toolbar + panel

- [ ] `ui/menu.js` — register "Scripts → Scruple" submenu with entries:
      Witness Now, Checkpoint ($5), C2PA sign ($10), Chain-lock ($100), Open Receipt, Settings.
- [ ] `ui/toolbar.js` — register a Scruple toolbar with the same actions as icon buttons.
- [ ] `ui/panel.js` — dockable panel via `ScriptModule` showing current project name, status,
      recent leaves, and paid-action buttons.
- [ ] Fee-gate on paid buttons: if no default payment method, label reads "Add card on scruple.ai"
      and opens the payment setup URL.

### Phase 6 — Payment flow (metered off-session)

- [ ] Setup happens in system browser on `scruple.ai/settings/payment` (Qt Script has no HTML
      surface for Stripe Elements).
- [ ] Every paid operator:
      1. `GET /api/stripe/payment-methods` to confirm PM on file.
      2. Native Qt confirm dialog ("Charge $5 to card ending 4242?").
      3. `POST /api/stripe/payment-intent` off_session confirm.
      4. `POST /api/lock/…` with the confirmed pi_XXX.
- [ ] 3DS fallback: opens browser to `/pay/3ds/<pi>` and resumes via callback (same pattern as
      Blender).

### Phase 7 — Mock-Harmony harness + tests

- [ ] `tests/mocks/harmony_mock.js` — fake `scene`, `MessageLog`, `SceneChangeNotifier`,
      `Application`, `preferences`, `System`, `QNetworkAccessManager`. Modeled on
      `/data/scruple-fusion/lib/fusion_mocks.py` + `/data/scruple-blender/tests/mocks/bpy_mock.py`.
- [ ] Test runner: Node.js under `qjs` or `vm` context. Aim for ≥60 tests.
- [ ] Coverage: auth, client, hashing, manifest canonicalisation, handler dispatch, prefs
      persistence, paid-action flow, retry queue.

### Phase 8 — Packaging

- [ ] `build/build_bundle.sh` produces `dist/scruple-toonboom-<version>.zip` containing the
      `Scruple/` bundle directory. User unzips into
      `~/Toon Boom Animation/Toon Boom Harmony Premium/21-scripts/` (path per Harmony version).
- [ ] Include install script (Windows `.bat` + macOS `.sh`) that auto-detects the Harmony
      preferences dir and copies files.

### Phase 9 — Docs

- [ ] `docs/install-quickstart.md` — filesystem drop, first-run auth, payment setup.
- [ ] `docs/architecture.md` — brief WHAT-not-HOW.
- [ ] `docs/developer.md` — repo layout, test running, packaging.
- [ ] `README.md` — top-level overview + supported Harmony versions.

### Phase 10 — Session report + memory + commit sweep

- [ ] Commit sweep on `main`. Note the `gh repo create Docenttx/scruple-toonboom` command in the
      session report; do not push (user's `gh` auth may not be in this session).
- [ ] Session report at `/data/scruple-toonboom/SESSION_REPORT_YYYY-MM-DD.md` with install
      steps, known gaps, morning smoke procedure.
- [ ] Memory `project_scruple_toonboom_shell_shipped_YYYY_MM_DD.md` + linked into `MEMORY.md`.

## Non-goals

- Native C++ SDK integration (paid, gated).
- Marketplace distribution (there isn't one).
- Real-time preview overlay in the Harmony viewport (out of scope for shell).
- Payment card entry in-panel (Qt is not HTML — browser handoff is the correct pattern).

## Effort estimate

Autonomous execution: **~6-9 hours** end-to-end for phases 0-10. Fits one overnight.
