# Session report — Scruple Fusion substrate proven end-to-end

**Date:** 2026-07-04 (spans 2026-07-03 → 2026-07-04)
**Branch:** `feature/pivot` (scruple-web) + `master` (scruple-fusion)
**Session outcome:** Full add-in ↔ palette ↔ server ↔ database round-trip validated on a real user's Fusion 360 install. Design work in Fusion now shows up in the palette in real time; switching between Fusion documents flips the palette's tracking indicator correctly; account-scan thumbnails survive the first save; C2PA signing pipeline shipped as Phase 1.

## Session goals

The user wanted to prove the Scruple Fusion pipeline on their own machine before running the full test plan (witness → checkpoint → chain lock → C2PA sign). That meant fixing the auth handshake, the auto-bind flow, the active-project surface, and the UI-side tracking indicator — none of which had been proven with a real Fusion install before this session.

Secondary goal: build the C2PA integration to Phase 1 (signing pipeline works with a self-signed dev cert) so it's ready when the substrate proves out.

## What was actually solved

### 1. C2PA integration — Phase 1 shipped end-to-end (commit `aa48bc3` scruple-web)

Signed a real project's thumbnail via the API. Manifest carries the actual `SCR-ID`, `leaf_hash`, and `merkle_root` from the DB. c2pa-rs validates every hash-URI binding, DigiCert TSA timestamps confirmed.

- **`services/c2pa-signer/sign.py`** — Python subprocess wrapping `c2pa-python 0.36`. Reads job spec on stdin, signs, writes signed asset, prints JSON result.
- **`lib/c2pa/signAsset.ts`** — Node wrapper. Spawns Python, builds a v2 manifest with `c2pa.actions.v2` (`c2pa.created` + `c2pa.published`), `cawg.training-mining` (`notAllowed` default), and product-specific `ai.scruple.provenance.v1` assertion.
- **`app/api/scruple/c2pa/sign/route.ts`** — Bearer-auth POST endpoint. Reads project + iteration rows to fill the assertion payload appropriate to the requested tier (`bare` / `witnessed` / `local` / `chain`). Tier prerequisites gated at 409.
- **`scripts/c2pa-sign.mjs`** — Headless CLI. Smoke-tested end-to-end against project 73 iteration 147.

Dev signing uses the c2pa-rs test cert + `verify_trust: false` (relaxed). Production cert path is SSL.com Level 1 Claim-Signing Cert + Generator Product registration (multi-week bureaucratic track — start when the substrate is otherwise ready).

Design doc: [`memory/project_scruple_c2pa_integration.md`](../../memory/project_scruple_c2pa_integration.md).

### 2. Sidebar archive feature (commit `aab8c8b` scruple-web)

User had 99 Fusion projects synced. Fusion palette sidebar was unusable. Landed:

- `POST/DELETE /api/projects/[id]/archive` (Bearer-auth) toggles `is_archived`
- `GET /api/projects?archived=live|only|all` extends the projects query
- Fusion palette fetches both lists in parallel each poll, renders live rows normally, collapsible "Archived (N)" section at the bottom
- Hover ⊘ button per live row; ↺ button per archived row

### 3. Observation harness — the strategic pivot (commit `fd2d998` scruple-web, `5c60371` scruple-fusion)

After chasing individual handoff bugs for an hour, switched to **evidence-first debugging**. The harness is now permanent infrastructure:

**Server side:**
- `POST /api/diag/fusion` stores events in a 2000-entry ring buffer keyed on module globals (survives per-request lifecycle).
- `GET /api/diag/fusion?since=<ms>` returns events since a cursor.
- `/embed/fusion/debug` renders the live stream — color-coded categories (auth/witness/command/sync/palette/error), per-category filters, freetext filter, pause/clear/autoscroll toggles.

**Add-in side:**
- Every `_diag_ping` auto-attaches `_module_context()` — `pid`, `id(_state)`, `FUSION_HANDOFF_SESSION[:8]`, disk-file presence, `active_project_id`. Stale-closure vs fresh-module events are visually distinct because their `state_id` differs.
- `_debug_flags()` reads `%APPDATA%\ScrupleFusion.debug.json` on every call. Flags: `verbose`, `log_all_commands`, `force_witness`, `witness_dry_run`, `disable_poller`. Edit + save = live behavior change, no code pull.
- CommandTerminated logs every `cmd_id` under `log_all_commands`.
- DocSaved / `_do_witness` pings enriched with `recovered` + precheck fields so branch skips are explicit.

The harness let us diagnose the entire auth chain in three iterations instead of many. Keep it in-tree.

### 4. Palette ↔ Python auth handshake — the big fix

This was 4-5 stacked bugs. Each one hid the next.

**a) `/api/fusion/handoff` GET was one-shot** (commit `344f27c`).
Palette POSTed a key, Python GET consumed the slot. Next `_ensure_api_key` recovery call got null. Fix: non-consuming read; TTL is the security backstop.

**b) Handoff poll thread had a 120s deadline** (commit `4cdab42` scruple-fusion).
After 2 min of no key, the poller exited. Fix: infinite loop with 30s heartbeat when key is set, 2s poll when not. Daemon thread dies with the add-in.

**c) On-demand key recovery in every handler** (commit `81366f9` scruple-fusion).
Fusion re-executes the `.py` module on add-in Start, but leaves OLD event handlers attached to the event bus. Those handlers hold a closure over the OLD `_state` singleton. The new module's poller sets the NEW `_state.api_key`, but the old handlers read the stale `_state` and see `None` forever. Fix: `_ensure_api_key(source=…)` helper that any handler can call on-demand. Tries `_state` → disk cache → `/handoff`.

**d) Disk cache for API key** (commit `f0f6d0a` scruple-fusion).
Once we recover a key anywhere, write it to `%APPDATA%\ScrupleFusion.key`. Any subsequent handler on any state closure reads the disk on-demand. Fully sidesteps the stale-closure problem — module reloads can't lose state that lives on disk.

**e) Persistent per-user handoff session** (commit `aa42e20` scruple-fusion).
`FUSION_HANDOFF_SESSION = secrets.token_hex(24)` per module load. Palette WebView cached with the OLD `?session=…` URL; new module minted a NEW session ID. Palette POSTed to session-A, Python GET queried session-B. Never met. Fix: session stored in `%APPDATA%\ScrupleFusion.session`, loaded on module init. First load mints and writes; all subsequent loads (Python or palette) read the same value.

**f) `/handoff?session=latest` fallback** (commit `7b3a881` scruple-web + `44475e4` scruple-fusion).
Even with the persistent session fix, Neutron's palette WebView cache proved harder to defeat than expected. Rather than fight Neutron, added a "latest" mode: `GET /api/fusion/handoff?session=latest` returns the newest slot regardless of session ID. Dev machine is single-user so the newest slot is unambiguously the palette's current key. Python `_ensure_api_key` tries its own session first, falls back to `latest`. THIS is what finally worked reliably.

### 5. Active-project tracking (commits `94f6141` scruple-web, `a1bf396`, `ccdfb91` scruple-fusion)

Once the auth chain was solid, the workspace still didn't reflect which Fusion doc was actually open. Wired the whole flow:

- **`POST /api/projects/[id]/set-active`** — flips `is_active=1` on given project, `0` on all others for that user
- **`POST /api/projects/clear-active`** — clears `is_active` on all user's projects (for blank/unsaved Fusion docs)
- **`ScrupleClient.set_active_project` / `clear_active_project`** methods
- **`_DocActivatedHandler` rewrite** — handles all three cases:
  - Unsaved doc → `clear_active_project()` → palette shows grey "○ Not tracking"
  - Saved + bound → `set_active_project(bound_id)` → palette snaps to it, green "● Tracking"
  - Saved + unbound → auto-bind path (which also calls `set_active`)
- **Palette follows server's `activeId`** — `refreshProjects` now updates `selectedId` whenever the server's active project changes. No stale sidebar selection.
- **Persistent tracking pill** — `WorkspaceView` shows the pill ALWAYS (green active / grey inactive) instead of hiding when `is_active=0`. Matches "always-visible state indicator" UX principle.
- **Killed the `ui.messageBox` tracking notice** — the workspace pill IS the notice. Same brand voice, no popup friction.

### 6. URN-based auto-bind dedupe (commit `c27a998` scruple-web + `1c3550b` scruple-fusion)

First save was creating a duplicate project row ("scrupletest1 v10", no URN, no thumbnail) because auto-bind called `create_project(name="scrupletest1 v10")` — Fusion's `activeDocument.name` includes the version suffix. Meanwhile, the account scan had already created a proper row keyed by lineage URN with the thumbnail.

Fix flow:
- Add-in grabs `activeDocument.dataFile.id` (URN) + `dataFile.name` (base name, no `v10`).
- Client sends `fusion_data_id` to `POST /api/projects`.
- Server dedupes by `(user_id, fusion_data_id)` — returns the existing row (with thumbnail intact) or creates new AND stamps the URN on the fresh row so future auto-binds match.

### 7. Stale-attribute self-heal (commit `ccdfb91` scruple-fusion)

Design still had `Scruple/project_id=179` attribute from the earlier bad auto-bind. Row 179 was deleted. DocActivated saw the stale attr, called `set_active(179)`, got 404, gave up. No re-bind ever happened.

Fix: on 404 from `set_active` (or on any exception when using an existing attr), catch the error, wipe `project_id` / `project_name` / `pre_scr_id` from `design.attributes`, and fall through to the URN dedupe path. The URN then finds the correct account-scan row and re-binds cleanly.

## Canon techniques worth carrying forward

These are patterns that will apply to future integration work, not just Fusion:

1. **Observation-first when a system has more than one moving part.** When 3+ debugging attempts fail to converge, stop guessing and build the harness. Ring buffer + live stream + runtime-editable flags = pull the truth out of a running system. Cheaper than any more speculation.

2. **Disk cache anything that must survive module reloads.** External runtime hosts (Fusion, ComfyUI, Autodesk, Adobe) reload Python modules aggressively. In-memory state resets; disk survives. Any secret / session / cache that a stale closure could lose belongs on disk.

3. **Persistent per-user IDs, not per-load IDs.** If two sides of a handshake need to agree on an ID, don't mint fresh each time. Load from disk, mint on first miss, both sides read the same file.

4. **Provide a "latest" fallback for session-keyed lookups.** Even with persistent sessions, upstream caches (Neutron, browser WebView, service worker) can wedge you on a stale ID. A `?session=latest` mode that returns the newest slot is a two-line escape hatch and completely eliminates a class of session-mismatch bugs on single-user dev machines.

5. **On-demand recovery in every code path that reads shared state.** Not "check once at startup" — a helper called AT USE. If the state is missing, recover it right there. Then even a stale-closure handler that captured the old `_state` singleton can bring itself up to date every time it fires.

6. **Stale-attribute self-heal on 404.** When an external system (Fusion design attributes, Chrome localStorage, filesystem, whatever) holds a reference to something the server has forgotten, don't propagate the error — wipe the stale reference locally and re-run whatever lookup would repopulate it. 404 is a signal to reset local caches, not to give up.

7. **Always-visible state indicators (green/grey), not hide-when-false.** A UI element that disappears on state change reads as broken. A dimmed version reads as informative. Same for the tracking pill: `● Tracking` in green vs `○ Not tracking` in grey. User's mental model updates smoothly.

8. **URN / stable-ID dedupe for external-source integrations.** When mirroring an external system's objects (Fusion Team Hub, Drive files, GitHub repos), key on the stable ID that external system provides — never on the display name. Names include version suffixes, get renamed, are case-inconsistent. IDs don't.

9. **Runtime-editable behavior via disk config.** For debugging complex flows, a JSON file that's re-read every check is much better than baking flags into code. `{"verbose": true, "log_all_commands": true}` in `%APPDATA%\ScrupleFusion.debug.json` toggles behavior without a code pull.

10. **Route notifications through the surface that can style them, not the substrate.** `ui.messageBox` is Windows-native and can't render brand assets. If you need styled notification, route through the palette (HTML surface). Same principle for Adobe / ComfyUI / any host that gives you both a native modal and an embed surface.

## Current live state

- ✅ Palette handshake via `latest` fallback
- ✅ Disk-cached key survives module reloads
- ✅ Persistent per-user handoff session
- ✅ Auto-bind by Fusion URN → matches account-scan row (thumbnail intact, no duplicates)
- ✅ Stale-attribute self-heal (404 → wipe → re-bind)
- ✅ Active project follows Fusion focus (open/switch/blank)
- ✅ Palette workspace persistent tracking pill (green active / grey idle)
- ✅ C2PA Phase 1 signing pipeline shipped and smoke-tested against a real project
- ✅ Observation harness in place — permanent infrastructure now

## Open items for next session

Substrate items (in priority order):

- **Confirm witness leaves land on save** — after all the auth work, we haven't actually verified `_do_witness` completes end-to-end for a real Fusion save. Should be trivial now but explicitly unproven. Save with palette open, watch for `_do_witness_precheck have_client:true have_project:true` → `witness_done`. Check `iterations` table gains rows.
- **Phase C** — Checkpoint via workspace lock button (Stripe test-pay).
- **Chain Lock & Anchor** — real RVN testnet mint via the pinned tier.
- **Phase D — C2PA sign at each tier** via the CLI, verify each PNG on `contentcredentials.org`.

C2PA production readiness (parallel track):

- SSL.com free-tier Claim-Signing Cert application (multi-week; start it now).
- CAI Generator Product registration.
- Blob storage endpoint for Fusion viewport screenshots (design in memory doc; not built).
- Multi-angle capture UI (design in memory doc; not built).
- Tier picker UI in the shared `LockButtons` component.

Follow-up polish:

- Retire the debug diag pings once the pipeline is stable (`_diag_ping` calls sprinkled everywhere are noisy for prod).
- Retire the observation harness endpoints from public surface (or gate them behind a dev flag).
- Palette-side rich notification for the tracking notice (currently the pill IS the notice, but if we want a one-time celebration on first bind, palette can render it with the wordmark PNG).

## Related in-tree docs

- Design docs: `memory/project_scruple_c2pa_integration.md`, `memory/project_scruple_fusion_external_source_witnessing.md`, `memory/reference_fusion_datafile_thumbnail.md`
- Previous session: `docs/session-report-2026-06-22-v2-overnight.md` (Canvas v2 build)
- Fusion fork memory: `memory/project_scruple_fusion_fork_2026_07_03.md`

## Commits landed this session

**scruple-web (`feature/pivot`):**
`aab8c8b` archive · `aa48bc3` C2PA phase 1 · `fd2d998` observation harness · `344f27c` handoff non-consuming · `7b3a881` handoff latest fallback · `94f6141` set-active endpoint · `3292037` persistent tracking pill · `6ffafeb` clear-active + palette activeId sync · `0cc7a92` publish scruple_client.py · `c27a998` URN dedupe

**scruple-fusion (`master`):**
`1e07654` viewport thumbnail via getAsBase64String · `255c906` thumbnail fix landed · `4cdab42` infinite poller · `81366f9` on-demand key recovery · `f0f6d0a` disk cache · `aa42e20` persistent session · `44475e4` latest fallback · `b81bf35` granular auto-bind pings · `7cf5506` Scruple® wordmark in notice · `b809c0a` set_active_project client · `a1bf396` clear_active on DocActivated · `1c3550b` URN in create_project · `ccdfb91` stale-attribute self-heal
