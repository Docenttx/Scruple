# WO-MESHROOM — Scruple for Meshroom (Python node plugin)

## Status
- **Started:** TBD
- **Owner:** claude (autonomous)
- **Prereq:** none for build. User provides no login, no keys, no accounts.
- **Target end state:** installable Meshroom plugin (drop-in directory) that adds a
  `ScrupleWitness` node to the graph editor, hooks the pipeline's final output stage,
  hashes the export, and posts a leaf to scruple.ai. Menu item "Scruple → Set up
  payment" opens the browser. Full pytest suite green under a mock-Meshroom harness.

## Why this target

- WIDEST OPEN plugin door of any candidate — fully open-source (AliceVision), Python 3
  nodes, drop `.py` into `meshroom/nodes/`, zero gatekeeper.
- Big install base among indies, students, cultural-heritage volunteers, small VFX shops.
- Real credibility play in the AI-training-data-provenance conversation. Every
  photogrammetric asset increasingly becomes 3D-gen model training data; provenance chain
  proves consent + licensing.
- Weekend build — the simplest of the plugin candidates.

## What's in vs. out of overnight scope

**In:**
- Custom `ScrupleWitness` Meshroom node (Python class inheriting from `meshroom.core.desc.Node`).
- Auth handshake, HTTP client, output hashing, canonical leaf, witness POST — direct port
  from the Blender addon.
- Menu registration for "Scruple → Set up payment" and "Scruple → Verify recent output."
- Mock-Meshroom harness for pytest.
- Install docs + packaging.

**Out:**
- In-panel payment card entry (Meshroom uses Qt, not HTML — browser handoff).
- Meshroom's shipping-with-AliceVision packaging story (that's an AliceVision decision).
- Live smoke inside real Meshroom (requires user with Meshroom installed).

## Reference patterns (reused)

- `/data/scruple-blender/lib/` — auth, client, capture, manifest, witness_flow, queue_store,
  payment. All port directly to a Meshroom addon package.
- `/data/scruple-blender/tests/mocks/bpy_mock.py` — pattern for a mock-Meshroom harness
  (fake `meshroom.core.desc`, `meshroom.core.graph`, `meshroom.ui.commands`).
- `/data/scruple-blender/build/build_addon.sh` — packager pattern.

## Meshroom API surface

- Node subclass: `class ScrupleWitness(desc.Node)` with `inputs`, `outputs`, `processChunk`.
- Register at import time via `meshroom.core.registerNodeType(ScrupleWitness)`.
- Menu items via `meshroom.ui.commands.CommandsManager` (if Meshroom UI is running).
- Meshroom's Python is 3.x; no compat shim needed.
- File-system path: `~/.meshroom/nodes/scruple/` OR the plugin gets shipped inside the
  Meshroom install tree at `share/meshroom/nodes/`.

## Phase map

### Phase 0 — Discovery + skeleton

- [ ] Read Meshroom docs (`meshroom-manual.readthedocs.io`) and source
      (`github.com/alicevision/Meshroom`) for the node plugin API. Freeze the node base class
      + registration mechanism.
- [ ] Create `/data/scruple-meshroom/` with `scruple_meshroom/` (Python package),
      `scruple_meshroom/__init__.py` (registerNodeType calls), `scruple_meshroom/nodes/`,
      `scruple_meshroom/lib/`, `tests/`, `build/`, `docs/`.
- [ ] Initialise git.

### Phase 1 — Auth + prefs

- [ ] `lib/auth.py` — deep-link + local callback handshake. Auth token cached in
      `~/.scruple/meshroom-auth.json` (0600).
- [ ] `lib/preferences.py` — thin config loader. No Meshroom-native prefs UI required for
      shell; the settings live in a JSON config file.
- [ ] Test: auth round-trip.

### Phase 2 — Client library

- [ ] `lib/scruple_client.py` — direct port from Blender.
- [ ] Test: mocked responses.

### Phase 3 — Node implementation

- [ ] `nodes/ScrupleWitness.py`:
      - inputs: `inputMesh` (File), `projectName` (String), `paidAction` (Choice:
        `witness | checkpoint | c2pa | chain-lock`).
      - outputs: `witnessLeaf` (File — JSON of the leaf + server signature),
        `receiptUrl` (String).
      - `processChunk(chunk)`: hash inputMesh, construct canonical leaf, POST to witness API,
        write leaf JSON + receipt URL to outputs.
- [ ] `nodes/ScrupleC2PA.py`: same pattern for C2PA-sign of texture/render outputs.
- [ ] Menu items: "Scruple → Set up payment", "Scruple → Verify recent output."
- [ ] Test: node instantiates, processChunk succeeds against a fixture mesh + mock server.

### Phase 4 — Payment flow (metered off-session)

- [ ] Setup: menu item opens `scruple.ai/settings/payment` in system browser.
- [ ] Paid nodes (checkpoint / c2pa / chain-lock): call
      `POST /api/stripe/payment-intent` with off_session, then `POST /api/lock/…`.
- [ ] If `requires_action` (3DS), write a placeholder output and log a resume-URL that the
      user opens in a browser to complete.

### Phase 5 — Mock harness + tests

- [ ] `tests/mocks/meshroom_mock.py` — fake `meshroom.core.desc.Node`, `desc.File`,
      `desc.StringParam`, `desc.ChoiceParam`, `Chunk`, `CommandsManager`.
- [ ] Coverage: hash, manifest, client, node processChunk, paid-action flow, prefs.
- [ ] Aim for ≥40 tests green under pytest.

### Phase 6 — Packaging

- [ ] `build/build_plugin.sh` produces `dist/scruple-meshroom-<version>.zip`. User unzips
      into `~/.meshroom/nodes/` or the Meshroom `share/meshroom/nodes/` tree.
- [ ] Include a `INSTALL.md` with the exact copy-target per OS.

### Phase 7 — Docs

- [ ] `docs/install-quickstart.md` — filesystem drop + first-run auth.
- [ ] `docs/using-scruple-node.md` — how to drop the node in the graph, wire inputs.
- [ ] `docs/architecture.md` — brief.
- [ ] `README.md` — top-level.

### Phase 8 — Session report + memory + commit

- [ ] Commit sweep on `main`. Session report at
      `/data/scruple-meshroom/SESSION_REPORT_YYYY-MM-DD.md`.
- [ ] Memory entry + MEMORY.md link.

## Non-goals

- AliceVision core changes.
- Cloud-hosted Meshroom pipeline (that's a Meshroom Studio decision, not ours).
- Real-time hooks — Meshroom is a batch pipeline; our value is on the output node.

## Effort estimate

**~3-5 hours** end-to-end. Genuinely easiest of the plugin candidates because Meshroom's
node model does most of the wiring for us.
