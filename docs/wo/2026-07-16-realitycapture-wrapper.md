# WO-REALITYCAPTURE — Scruple wrapper for RealityCapture (CLI post-processor)

## Status
- **Started:** TBD (deprioritised; pick up on partnership demand)
- **Owner:** claude
- **Prereq:** none for build. Windows host + RealityCapture license required for the
  morning smoke.
- **Target end state:** Windows companion CLI + optional service that watches
  RealityCapture's export directory, hashes new outputs, and posts a signed leaf to
  scruple.ai. Also ships an RCC-compatible batch script fragment operators can append
  to their existing RCC pipelines to trigger the same behaviour deterministically.

## Honest positioning

**RealityCapture has no in-app plugin API.** This is a wrapper, not a plugin. The
operator's UX is either (a) run a Scruple tray tool that auto-witnesses on file drop, or
(b) append a Scruple line to their RCC batch script. There is no panel in RealityCapture
itself, no menu, no toolbar. That materially weakens the pitch versus Blender / Toon Boom
/ AE / Meshroom, where Scruple can live inside the operator's daily workflow.

**Build this only if a specific VFX-house partnership or NAVSEA-shape federal customer
requires it.** Otherwise the other three plugins in this batch produce more value per
engineering hour.

## Why the target still has value

- HIGH regulatory pull — VFX studios delivering to EU streamers (Netflix / Prime / Disney+)
  face AI-content disclosure requirements in vendor contracts. Photogrammetric assets
  need to be distinguishable from AI-generated 3D.
- Epic Games made RealityCapture free in 2024; install base is expanding fast in the
  Unreal pipeline crowd.
- Cultural heritage — museum digital-twin projects with EU cultural-heritage funding often
  require cryptographic provenance chains on scan outputs.

## What's in vs. out of scope

**In:**
- Cross-platform Python CLI (Windows primary, macOS + Linux secondary).
- File-watcher on a configured directory (defaults to RealityCapture's user output path).
- Auth handshake with scruple.ai.
- Hash + witness POST for each new file matching a configured pattern
  (`.obj`, `.fbx`, `.ply`, `.usd`, `.glb`, `.tif`, etc.).
- Optional Windows tray icon (via `pystray`) so the operator sees the tool is live.
- RCC batch script fragment users can paste into their existing pipeline scripts.
- Test suite against a mocked file-watcher and mock HTTP endpoint.

**Out:**
- Any in-app UI inside RealityCapture (impossible — no plugin API).
- Payment card entry (browser handoff to `scruple.ai`, same as other plugins).
- Deep integration with RealityCapture's internal metadata (RCC output is opaque; we
  only see the exported artefacts).

## Reference patterns

- `/data/scruple-fusion/lib/queue_store.py` — offline retry queue with exponential backoff;
  port unchanged.
- `/data/scruple-blender/lib/scruple_client.py`, `lib/manifest.py`, `lib/auth.py` — direct
  port to a standalone Python 3 CLI.
- Any file-watcher tutorial using `watchdog`.

## Phase map

### Phase 0 — Discovery + skeleton

- [ ] Read RealityCapture CLI / RCC docs (`RealityCapture.exe -help`,
      `capturingreality.com/docs`) and confirm the export step's output paths + naming.
- [ ] Create `/data/scruple-realitycapture/` with `scruple_rc/` (Python 3 package),
      `bin/scruple-rc` (CLI entry), `tests/`, `build/`, `docs/`.
- [ ] Initialise git.

### Phase 1 — Auth + config

- [ ] `scruple_rc/auth.py` — deep-link + local callback (port from Blender).
- [ ] `scruple_rc/config.py` — YAML/JSON at `~/.scruple/rc-config.yaml`: watched
      directories, file-glob patterns, project mapping.

### Phase 2 — Client

- [ ] `scruple_rc/client.py` — direct port from Blender addon.

### Phase 3 — File-watcher + capture

- [ ] `scruple_rc/watcher.py` — `watchdog` observer on configured directories. On file
      creation matching pattern: enqueue.
- [ ] `scruple_rc/capture.py` — hash the file, construct canonical leaf, POST to witness.
- [ ] Retry queue on network failure.

### Phase 4 — CLI entry points

- [ ] `bin/scruple-rc auth` — initial sign-in.
- [ ] `bin/scruple-rc daemon` — foreground watcher.
- [ ] `bin/scruple-rc watch --once <path>` — one-shot witness of a specific file.
- [ ] `bin/scruple-rc payment` — opens `scruple.ai/settings/payment` in browser.
- [ ] `bin/scruple-rc checkpoint|c2pa|chain-lock --project <id>` — trigger a paid action
      on a witnessed project.

### Phase 5 — Optional Windows tray

- [ ] `scruple_rc/tray.py` — `pystray` icon showing daemon status, recent leaves.
      Optional; degrade gracefully if `pystray` not installed.

### Phase 6 — RCC batch script fragment

- [ ] `docs/rcc-integration.md` — a copy-paste snippet users add to their existing RCC
      batch scripts. Runs `scruple-rc watch --once` on the exported artefact synchronously
      so it's guaranteed to fire in the operator's pipeline.

### Phase 7 — Mock harness + tests

- [ ] `tests/mocks/watchdog_mock.py` + `tests/mocks/http_mock.py`.
- [ ] Coverage: config load, auth, client, hash, watcher dispatch, retry queue, tray,
      paid actions.
- [ ] Aim for ≥40 tests green.

### Phase 8 — Packaging

- [ ] `build/build_windows.sh` produces a `.msi` via `wix` (or `pyinstaller --onefile`
      + a batch installer).
- [ ] `build/build_mac.sh` produces a `.pkg`.
- [ ] `build/build_linux.sh` produces a `.tar.gz` with a simple install script.

### Phase 9 — Docs

- [ ] `docs/install-quickstart.md` per OS.
- [ ] `docs/rcc-integration.md` — the batch script story.
- [ ] `docs/architecture.md` — brief; specifically call out that this is a wrapper, not
      a plugin, so operators know what to expect.
- [ ] `README.md` — top-level.

### Phase 10 — Session report + memory + commit

- [ ] Commit sweep. Session report. Memory entry + MEMORY.md link.

## Non-goals

- In-app UI (impossible).
- Deep RCC internal metadata (opaque).
- Non-file outputs (RealityCapture's outputs are files; that's the whole surface).

## Effort estimate

**~4-6 hours** for phases 0-10 given the code reuse from Blender addon. Windows `.msi`
packaging adds ~1 hour. macOS `.pkg` code-signing adds unknown depending on user's
Apple developer account availability.

## Recommendation

**Skip unless partnership demand appears.** The other three WOs in this batch — Toon Boom,
Meshroom, After Effects — each produce a stronger regulatory-forced sale per hour of
build. Keep this WO on file so it's ready if a NAVSEA-shape federal customer or a specific
VFX studio partnership needs it as a substrate.
