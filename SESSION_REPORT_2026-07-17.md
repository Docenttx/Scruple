# Scruple for Blender - session report

**Session:** overnight 2026-07-16 into 2026-07-17
**Owner:** claude (autonomous execution)
**WO:** `/data/scruple-web/docs/wo/2026-07-16-blender-shell.md`
**Repo:** `/data/scruple-blender/` (local git only; push deferred to user)

## Status: SHIPPED (shell complete, ready for morning smoke)

## What shipped

### Repo
- Fresh git repo at `/data/scruple-blender/`, 4 commits.
- `README.md`, `LICENSE` (proprietary, Docent LLC), `blender_manifest.toml`
  targeting Blender 4.2 LTS+, `bl_info` fallback for 3.6/4.0/4.1 in
  `__init__.py`.
- Publisher fields set to "Docent LLC (dba Docent Technologies)"; contact
  `scruple@docentechs.com`.

### Code (all in `/data/scruple-blender/`)
- `lib/auth.py` - browser handshake with local `http://127.0.0.1:53171-53199`
  callback server, disk cache at `~/.scruple/blender-auth.json` (0600).
- `lib/preferences.py` - `AddonPreferences` UI with sign-in status, payment
  CTA button, base URL, verbose-logging toggle.
- `lib/scruple_client.py` - urllib HTTP client, bearer auth, ports to
  `/api/projects`, `/api/witness/cad`, `/api/stripe/config`,
  `/api/stripe/payment-intent`, `/api/stripe/confirm`, `/api/lock/checkpoint`,
  `/api/lock/local`, `/api/lock/chain`.
- `lib/manifest.py` - canonical JSON + machine_manifest + workflow builders.
  Byte-for-byte compatible with the server's `canonicalize` in
  `/data/scruple-web/app/api/witness/cad/route.ts`.
- `lib/capture.py` - render/save/export capture pipeline: streaming SHA-256,
  Blender `//`-path expansion, `####` frame-hash substitution, scene
  inventory, render-settings extraction.
- `lib/handlers.py` - registers `render_complete`, `render_write`, `save_post`.
  Each dispatches to a background `WitnessWorker` thread so the UI never
  blocks.
- `lib/witness_flow.py` - composes capture + client, records receipts,
  ensures project on first witness.
- `lib/payment.py` + `lib/paid_action.py` - off-session payment flow: charge
  card on file, invoke Blender-native `invoke_props_dialog` for confirm,
  post the resulting `pi_...` into the matching lock endpoint.
- `lib/queue_store.py` - JSONL retry queue with backoff cap; ported from
  Fusion.
- `lib/state.py`, `lib/logging.py` - cross-module state + verbosity toggle.

- `panels/main.py` - 3D Viewport N-panel with project header, "Witness Now",
  "Witness an export...", paid buttons with server-priced labels, recent
  receipts list, error surface.

- `operators/` - `sign_in`, `sign_out`, `witness_now`, `witness_export`,
  `checkpoint`, `c2pa_sign`, `chain_lock`, `open_receipt`, `setup_payment`,
  `resume_payment` (3DS follow-up).

### Tests
- **81 passing tests** in under 5 seconds against `pytest`.
- `tests/mocks/bpy_mock.py` - minimal `bpy` surface (handlers, ops, panels,
  props, context, window_manager.invoke_props_dialog) modelled on the
  Fusion mock pattern.
- `tests/mocks/http_mock.py` - `urlopen`-compatible in-memory mock; the
  ScrupleClient accepts an `opener=` arg so every HTTP call in tests is
  recordable and hermetic.
- Coverage: manifest canonicalization + golden vectors, capture hash +
  frame substitution + inline-limit gate, client request shapes,
  auth disk cache + callback server end-to-end, payment PM-gate +
  requires_action, paid-action spine, handler install/uninstall
  idempotency + preserve-third-party-handlers, background-worker
  execution + exception isolation, operator surface with mock bpy.

### Packaging
- `build/build_addon.sh` - stages the addon under `build/artifacts/`,
  runs `python -m compileall` as a syntax gate, produces
  `dist/scruple-blender-0.1.0.zip` (37 KB).
- Zip contents drop into the Blender Extensions layout
  (`scripts/addons_core/scruple_blender/...`) so it installs both
  as an Extension (4.2+) and as a classic addon (3.6/4.0/4.1).
- `build/build_addon.sh --publish` prints a dry-run message; real
  submission is user-only.

### Docs
- `README.md`, `docs/install-quickstart.md`, `docs/architecture.md`,
  `docs/developer.md`.

## Morning smoke: exact steps

Copy `/data/scruple-blender/dist/scruple-blender-0.1.0.zip` to your dev
machine. Then in Blender 4.2+:

1. Drag the zip into any Blender window. Confirm the Extensions install.
2. Or: Edit -> Preferences -> Add-ons -> Install from Disk -> pick the zip.
   Enable "Pipeline: Scruple".
3. In the addon preferences (expand Scruple), click **Sign in**. Browser
   opens on `https://scruple.ai/settings/keys/desktop?...`. Confirm
   sign-in; the local callback returns you to Blender. Account row now
   reads "Signed in".
4. Click **Set up payment on scruple.ai**. Add a card in the Stripe form.
   Return to Blender.
5. Open a `.blend`, render (F12).
6. Open the 3D Viewport N-panel -> Scruple tab. Confirm:
   - A project row appears with a name from the scene.
   - A Recent-receipt entry appears under "render" with a leaf hash.
7. Click `Checkpoint  $5.00`. Confirm the dialog. Verify a checkpoint
   entry lands in the receipts list.
8. Click `C2PA sign  $10.00`. Confirm. Verify a c2pa entry.
9. Click `Chain-lock  $100.00`. Confirm. Verify a chain-lock entry
   with `scr=...` and `tx=...`.

Any deviation is a shell bug; see "Known gaps" below before assuming.

## Push to GitHub (user runs, no `gh` in this session)

The WO called for `github.com/Docenttx/scruple-blender`. This session
has no `gh` CLI available, so nothing was pushed. To push in the morning:

```
cd /data/scruple-blender
gh repo create Docenttx/scruple-blender --private --source=. --push --description "Scruple provenance addon for Blender"
```

(Add `--public` instead of `--private` if that's the plan. First push
carries the 4 commits already on `main`.)

## Known gaps for morning follow-up

1. **Auto-witness on export.** Blender lacks a generic `export_post`
   handler list; wrapping each of `bpy.ops.export_scene.gltf`, `.fbx`,
   `.obj`, `bpy.ops.export_mesh.usd` requires subclass + re-register
   dance per format. Shipped: manual `Witness an export...` operator in
   the N-panel (user picks the file). Auto-wrap is straightforward
   follow-up (2-4 hours, per format).
2. **URL-scheme `scruple://` registration.** Handshake and 3DS resume
   both rely on `scruple://` deep links. On this shell:
   - Sign-in uses the local HTTP callback fallback instead (works
     everywhere, no OS registration).
   - 3DS resume is exposed as the manual `scruple.resume_payment`
     operator (user pastes `pi_...`). Once the OS scheme is registered
     at install time (macOS Info.plist, Windows registry, Linux
     xdg-mime), the resume can auto-fire. Adding the manifest entries
     is 30 minutes of installer work.
3. **`panels/preferences.py` module.** The WO listed a separate
   preferences panel; Blender's `AddonPreferences.draw()` renders the
   preferences UI directly, so a separate module would be dead weight.
   The UI is in `lib/preferences.py::ScrupleAddonPreferences.draw`.
4. **Response 402/requires-payment status detection.** Payment path
   assumes the server returns HTTP 200 with `status=requires_action`.
   If the server actually surfaces 402 with the same body, the client
   will raise `ScrupleClientError` and we'll need to peel the body
   from `e.body` inside `payment.charge`. Low risk; add a targeted
   test the moment we see the real response shape.
5. **Extensions catalog submission.** Requires the user's Blender ID
   plus a hand-review by the Extensions team. `build_addon.sh
   --publish` is a dry-run today.
6. **Live scruple-web integration test.** Every current test uses the
   in-memory HTTP mock. A `pytest -m live` marker + a fixture that
   points at `http://127.0.0.1:3001` would be an easy add once the
   user has the dev server + a seeded account key.

## Files of note

- Addon entry: `/data/scruple-blender/__init__.py`
- Manifest: `/data/scruple-blender/blender_manifest.toml`
- Client: `/data/scruple-blender/lib/scruple_client.py`
- Tests: `/data/scruple-blender/tests/` (81 tests)
- Zip: `/data/scruple-blender/dist/scruple-blender-0.1.0.zip`
- Build: `/data/scruple-blender/build/build_addon.sh`
- Session report: this file

## Commit history

```
d03234d Phases 8-9: packager build script + docs (install/architecture/developer)
b69188a Phase 7: mock bpy harness and pytest suite (81 tests green)
ffc2da9 Phases 1-5: auth, prefs, client, capture, handlers, operators, panel
ed8bcba Phase 0: skeleton — dirs, manifest, entry point, license
```

(Phase 6 payment flow landed inside the phases-1-5 commit; Phase 10 is
this report + a memory update.)
