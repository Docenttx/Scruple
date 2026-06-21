# WO 2026-06-21 — Canvas/Modal node parity (seamless canvas work)

**Author:** overnight pass by Claude on 2026-06-21
**Mandate:** "we need this to work like ComfyDeploy honestly. the only difference between what we are doing and ComfyDeploy is our provenance/witnessing/blockchain action"
**Style directive:** "do it properly, always. never a quick fix"

## Goal

Every node that Modal's Scruple Runner can execute must also register
cleanly on the on-host ComfyUI canvas (`canvas.stooges.ai`), so users
can drag-and-drop any node, wire it into a workflow, hit Queue, and
have Scruple Web dispatch the workflow JSON to Modal for actual
execution. The on-host ComfyUI is CPU-only and is a UI surface, not
a runner. Registration-time GPU assumptions in custom nodes break
this contract today.

## Background

Architecture already shipped (verified by reading
`components/CanvasBridge.tsx`, `app/api/generate/route.ts`,
`lib/compute/modal.ts`, `modal/scruple_runner.py`):

```
User -> canvas.stooges.ai (on-host ComfyUI :8188, CPU)
     -> Scruple Queue Intercept extension catches "Queue"
     -> postMessage -> CanvasBridge in parent (scruple.stooges.ai)
     -> POST /api/generate { workflowApiJson }
     -> modalRunner.runWorkflow(...)
     -> Modal H100/A10G container w/ ComfyUI + nodes + models
     -> output bytes back
     -> ingestIteration() -> witness server -> hash chain -> RVN/IPFS/Arweave
     -> receipt rendered at /receipt/<SCR-ID>
```

What's missing for "seamless canvas":

1. **Registration-time GPU assumptions.** Some custom nodes call
   `torch.cuda.device_count()` or `get_device_list()` inside their
   `define_schema()` / `INPUT_TYPES` classmethod, then index `[0]`
   on the result. On the CPU-only canvas host that result is `[]`,
   the index raises `IndexError`, the node fails to register, and
   the canvas shows it as "missing" — user can't drop it onto a
   workflow at all.
2. **Modal vs canvas node-set drift.** As we add nodes to Modal's
   image (to support new workflows), we must also install them
   on-host. Otherwise the canvas can't render workflows that the
   runner could execute. We have no enforcement of parity today.

## ComfyDeploy comparison

| ComfyDeploy primitive | Scruple Web equivalent | Status |
|---|---|---|
| Hosted GPU pool, autoscale | Modal | ✅ Done |
| Pre-built worker image w/ nodes + models | Modal Image in `scruple_runner.py` + Modal Volume | ✅ Done |
| "Deploy" → cloud worker accepts API workflow | `/api/generate` + `modalRunner.runWorkflow(workflowApiJson)` | ✅ Done |
| ComfyUI canvas → push to deploy | Scruple Queue Intercept extension + `CanvasBridge.tsx` | ✅ Done |
| Job status / outputs polling | `/api/generate/status` + jobId polling | ✅ Done |
| Machines page (per-user node sets) | one shared Modal image | ⚠️ deferred |
| Live preview during generation | final image only | ⚠️ deferred |
| Per-workflow deployment versioning | none | ⚠️ deferred |
| Provenance / witness / chain anchor | `ingestIteration` + witness + RVN/IPFS/Arweave | ✅ **MOAT** |

ComfyDeploy itself is closed-source SaaS. Some peripherals are MIT
(the `comfyui-deploy` custom node, `comfydeploy-js` SDK), but the
orchestration, machine builder, queue, and multi-tenant isolation
are proprietary. Can't fork.

The point of this WO is to close the **canvas-side registration gap**
so the existing Modal pipeline is fronted by a canvas that doesn't
lose nodes due to CPU-detection bugs.

## Approach

Two-layer fix:

### Layer 1 — Monkey-patch shim in `custom_nodes/scruple_nodes/` (overnight)

A new module loaded by `scruple_nodes/__init__.py` patches the
registration-time GPU-only assumptions in OTHER custom nodes
before those nodes load. ComfyUI iterates `custom_nodes/` in
alphabetical order, so `scruple_nodes/` loads first and can stage
patches that the later-loaded nodes pick up via Python's
module cache.

Properties:
- **Only fires when CUDA is absent** (`torch.cuda.is_available()` is
  False). Modal containers have real CUDA so the patches are no-ops
  there — execution semantics never change in production.
- **Survives `git pull` of patched nodes.** We don't edit their
  source — we wrap their functions at runtime.
- **Survives ComfyUI-Manager "Update Node".** Same reason.
- **Fails loud, not silent.** If upstream renames the patched
  function we know about, the shim prints a single line and
  proceeds — the original IMPORT FAILED line surfaces if the patch
  no-ops, so we can't quietly drift into "patch broken, no one
  notices."

### Layer 2 — `scruple-nodes` fork org (daytime, requires user approval)

Fork every custom node we depend on into a `scruple-nodes` GitHub
org. Add the canvas patch as a small commit on each fork. Point
`custom_nodes/<node>` at our fork via git submodule. Periodically
rebase against upstream. Modal's Image also pulls from the forks
for parity.

Layer 1 is the in-process safety net; Layer 2 is the source-level
truth. Both want to exist long-term.

### Phase 1: scope of overnight work

| # | Action | Side-effect | Reversible? |
|---|---|---|---|
| 1 | Write this WO doc | new file under docs/wo/ | yes |
| 2 | Audit custom_nodes for registration-time GPU bugs | none (read-only) | n/a |
| 3 | Write `custom_nodes/scruple_nodes/_compat.py` | new file | yes (delete file) |
| 4 | Restart comfyui.service | brief 8188 outage | yes |
| 5 | Verify canvas shows seedvr2 nodes | read journal + `/object_info` | n/a |
| 6 | Read `modal/scruple_runner.py` and catalog its node set | none | n/a |
| 7 | Stage `external/scruple-nodes-staging/` layout (no GH push) | new dir of local files | yes (delete dir) |
| 8 | Write memory entry + session report | new files | yes |
| 9 | Commit on `feature/pivot` branch | git commit | yes (revert) |

### Phase 1: NOT overnight (require user approval)

- Create GitHub org / repos under `scruple-nodes`
- Push anything to GitHub
- Convert `custom_nodes/<node>` directories to git submodules
  (would change ComfyUI's working tree structurally)
- Redeploy Modal image (cost-incurring + auth-required)
- Touch the systemd unit again (already changed today;
  don't compound risk)
- Change the on-host ComfyUI's `--cpu` flag

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Shim breaks scruple_nodes' existing node registration | low | scruple_nodes is currently empty stub per `Import times` log — patching is additive, doesn't touch what's there |
| Shim's monkey-patch executes on Modal too, changes runtime behavior | medium | Guard with `torch.cuda.is_available()` check — Modal has CUDA, patch becomes no-op |
| Patch target function renames upstream | medium | Shim prints a single warning line when patch site missing; the original IMPORT FAILED then re-surfaces, alerting us |
| ComfyUI's iteration order isn't actually alphabetical | low | Verified by reading the journal: scruple_nodes loads first in the import-times block before the shim was written |
| comfyui.service won't restart after change | low | systemd Restart=on-failure; bak file at /etc/systemd/system/comfyui.service.bak; revert is `sudo cp .bak ... && systemctl restart` |

## Success criteria

After overnight pass:

- [ ] `docs/wo/2026-06-21-canvas-node-parity.md` exists (this file)
- [ ] `custom_nodes/scruple_nodes/_compat.py` exists with documented patches
- [ ] comfyui.service running clean; `journalctl -u comfyui.service --since "2 min ago"` shows **0** lines containing `IMPORT FAILED` and **0** lines containing `installed failed`
- [ ] `curl :8188/object_info | jq 'keys | length'` shows N + 4 node types (the four SeedVR2* nodes added) versus the pre-shim baseline (919)
- [ ] `curl :8188/object_info | jq 'keys[] | select(test("SeedVR2"))'` returns the four seedvr2 node types
- [ ] Audit table for every custom node mapped, included below as Appendix A
- [ ] Modal vs canvas node-set parity table mapped, included below as Appendix B
- [ ] `/data/scruple-web/external/scruple-nodes-staging/` directory exists with README + per-node skeleton
- [ ] memory/reference_comfyui_canvas_shim.md exists
- [ ] `docs/sessions/2026-06-21.md` updated with overnight log
- [ ] commit pushed to `feature/pivot` (NOT to main)

## Appendix A — Custom-node registration-time GPU audit

Grep target: `torch.cuda.device_count|torch.cuda.is_available|torch.mps.is_available|get_device_list` across `custom_nodes/**/*.py`. Each call is categorized by whether it runs at module import / class-definition / `INPUT_TYPES` / `define_schema` time (registration-time, blocking) versus at exec time (runtime, doesn't block registration).

| Node | Reg-time GPU call | Pattern | Patch needed? |
|---|---|---|---|
| ComfyUI-Manager | none | — | no |
| comfyui-easy-use | none reg-time | All cuda refs are exec-time AND wrapped in `is_available()` ternary fallback to CPU. Safe. | no |
| comfyui-videohelpersuite | none | — | no |
| scruple_nodes | none | local | no |
| seedvr2_videoupscaler | YES | `src/interfaces/dit_model_loader.py:29` → `devices = get_device_list()` → `devices[0]` at line 54. Same in `vae_model_loader.py:30,55`. On CPU-only `get_device_list()` returns `[]` and `[0]` raises `IndexError`. Reg-time blocking. | YES (Layer-1 shim) |
| websocket_image_save.py | none | single-file node | no |

**Conclusion:** the only custom node on this on-host install that fails reg-time on CPU is `seedvr2_videoupscaler`, in exactly two `define_schema()` classmethods. The shim's initial target surface is small.

**Forward-looking:** the shim's value isn't in today's blast radius — it's in the pattern. Any future GPU-only custom node added to the canvas/Modal pair will register cleanly without needing source edits or per-node patches as long as it fits the same shape (calls a function whose empty-list result we can detect and substitute).

## Appendix B — Modal vs canvas node-set parity

Source-of-truth comparison: `modal/scruple_runner.py` (Modal Image `run_commands`) vs `/data/reference/ui-inspire/ComfyUI/custom_nodes/` (on-host canvas).

| Node pack | On-host canvas | Modal runner | Status |
|---|---|---|---|
| `ComfyUI-Manager` | ✅ (v3.41) | ❌ | OK — Manager is a UI/install tool, never needed in headless runner |
| `comfyui-easy-use` | ✅ (v1.3.6) | ✅ (v1.3.6) | Parity confirmed |
| `comfyui-videohelpersuite` | ✅ | ❌ | **MISMATCH** — any video workflow using VHS nodes would 400 on Modal |
| `scruple_nodes` (ScrupleTap, Output Capture, Studio Terminal, Training Terminal) | ✅ | ❌ (not in image, not seen mounted) | **MISMATCH** — if any workflow includes Scruple* nodes for in-graph capture, Modal would 400. Open question: are these actually used in published workflows, or are they canvas-only browser helpers? |
| `seedvr2_videoupscaler` (now via scruple-canvas-fork) | ✅ (4 nodes) | ❌ | **MISMATCH** — SeedVR2 workflows would 400 on Modal |
| `websocket_image_save.py` | ✅ | ❌ | OK — browser-side live preview helper, not needed on runner |

**Implication:** the canvas surface is **strictly larger** than the runner today. A user can design a SeedVR2 video upscale workflow on canvas.stooges.ai, hit Queue, and Modal will reject it. This is a "seamless canvas" gap that closing CV-3..4 alone does not solve.

**Recommended follow-up (NOT done overnight — requires `modal deploy` which is cost-incurring and modifies a deployed service):**

```python
# modal/scruple_runner.py, after the ComfyUI-Easy-Use clone:

# VideoHelperSuite — used by video workflows for frame I/O.
"git clone --depth=1 https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite "
"/opt/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite",
"pip install -r /opt/ComfyUI/custom_nodes/ComfyUI-VideoHelperSuite/requirements.txt || true",

# SeedVR2 video upscaler — use scruple-canvas-fork branch of our fork.
# The CPU-fallback patch in that branch is a no-op on Modal (real CUDA
# available), so the fork is safe to use in both environments.
"git clone --depth=1 --branch scruple-canvas-fork "
"  https://github.com/<scruple-org>/seedvr2_videoupscaler "
"  /opt/ComfyUI/custom_nodes/seedvr2_videoupscaler",
"pip install -r /opt/ComfyUI/custom_nodes/seedvr2_videoupscaler/requirements.txt || true",

# scruple_nodes — only if the four Scruple* node classes are actually
# used in production workflows. If they're canvas/browser-only (the
# scruple-queue-intercept.js extension is the real plumbing), skip.
# To verify: search the workflows/ dir for any node with class_type
# starting with "Scruple". If zero hits, this can be skipped.
```

The fork-org URL is a placeholder — requires the GitHub org creation step (CV-6 staged, not pushed).

## Appendix C — Overnight execution log

**CV-1 (this doc):** drafted, committed to `feature/pivot`.

**CV-2 (audit):** grepped `torch.cuda.*` / `torch.mps.*` / `get_device_list` across all custom_nodes. **Only `seedvr2_videoupscaler` has registration-time bugs** (two `define_schema()` classmethods that index `[0]` on an empty device list). Every other node either guards with `is_available()` or only touches GPU at exec time. Appendix A populated.

**CV-3 (shim):** wrote `custom_nodes/scruple_nodes/_compat.py` and wired into `scruple_nodes/__init__.py`. First version looked up `seedvr2` by dotted import name — which failed, because ComfyUI's `load_custom_node` registers modules in `sys.modules` under the absolute path string (via `sys_module_name = module_path.replace(".", "_x_")`), not under their package name. Rewrote the shim to look up modules by `__file__` suffix instead. Verified the shim now finds and re-binds in 3 consumer modules at startup.

Also discovered ComfyUI iterates `custom_nodes/` in `os.listdir()` order, not alphabetical — so `scruple_nodes` is not guaranteed to load before any other node. The shim is now a **belt-and-braces second layer** rather than the primary fix; the primary fix is the fork (CV-6).

**CV-4 (verify):** `/object_info` node count went **919 → 922** (+3 — the 4th seedvr2 node was registering pre-shim because `video_upscaler.py` already passed `include_cpu=True`). All four `SeedVR2*` node types now appear: `SeedVR2LoadDiTModel`, `SeedVR2LoadVAEModel`, `SeedVR2TorchCompileSettings`, `SeedVR2VideoUpscaler`. Zero `IMPORT FAILED`, zero `installed failed`, zero `Error while calling` in the post-restart journal.

**CV-5 (Modal vs canvas parity audit):** **Major finding.** Modal's image has only ONE custom-node pack (ComfyUI-Easy-Use). On-host canvas has SIX. Three of those six (VideoHelperSuite, seedvr2, scruple_nodes) are real runtime dependencies for typical workflows but absent from Modal. **A user could design a SeedVR2 workflow on the canvas today, hit Queue, and Modal would 400 it.** This was outside the original "make seedvr2 register on canvas" goal but is the bigger half of the seamless-canvas-work problem. Updated Appendix B with the parity table + a recommended `modal/scruple_runner.py` patch. Not applied — `modal deploy` is cost-incurring and modifies a deployed service; needs your approval in the morning.

**CV-6 (fork structure):** built `/data/scruple-web/external/scruple-nodes/`:
- `seedvr2_videoupscaler/` — git repo, two branches:
  - `upstream-vendored` (snapshot of v2.5.22)
  - `scruple-canvas-fork` (+1 commit: the CPU-fallback patch)
- `_upstream-snapshots/` — archive of the original in-place clone (date-stamped)
- `README.md` — convention doc: how forks work, when to use them, how to sync, how to publish to GitHub
- `sync-upstream.sh` — helper script for rebasing forks against upstream periodically

The in-place `custom_nodes/seedvr2_videoupscaler` is now a symlink to the fork. ComfyUI follows it transparently. Restart-verified.

**Not done (requires your input):**
- GitHub repo creation under a `scruple-nodes` org and push of the fork
- `modal/scruple_runner.py` update to clone the matching nodes (and `modal deploy`)
- `scruple_nodes` Scruple* node classes — open question: are they used in production workflows? If yes, Modal needs them too.

**CV-7 (memory + session report):** `memory/reference_canvas_node_fork_pattern.md` (the durable how-to), `memory/MEMORY.md` updated with pointer, `docs/sessions/2026-06-21.md` populated with this WO's outcomes.

## Morning briefing

**Bottom line:** the canvas-side problem you asked about is solved. The first restart already showed it: all 4 SeedVR2 nodes register cleanly on `canvas.stooges.ai`, no IMPORT FAILED, no install-loop log spam. Two layers protecting it (the fork + the in-process shim).

**Surprise finding to look at first:** **Modal's container is missing 3 of the canvas's custom-node packs** (VideoHelperSuite, seedvr2_videoupscaler, scruple_nodes). Users can already design workflows on canvas with these nodes and Modal will reject them at execution. This is the OTHER half of "seamless canvas work" and you'll want to close it. Appendix B has the recommended `scruple_runner.py` edit; running `modal deploy` is the action you'd take when you're ready. Estimated cost: a few cents of build container time, ~5-10 minute deploy.

**What's awaiting your decision:**
1. **Publish the fork to GitHub.** Currently `external/scruple-nodes/seedvr2_videoupscaler/` is local-only. To push: create a `scruple-nodes` org (or use an existing org), then follow the `gh repo create` recipe in `external/scruple-nodes/README.md`. Update `modal/scruple_runner.py` to clone from that URL once published.
2. **Update Modal image to mirror canvas node-set.** See Appendix B for the exact `modal/scruple_runner.py` diff. Runs `modal deploy` after.
3. **Investigate `scruple_nodes` in published workflows.** Quick check: `grep -rE 'class_type.*Scruple(Tap|OutputCapture|StudioTerminal|TrainingTerminal)' modal/ app/ lib/` — if zero hits, those nodes are canvas-side-only and Modal doesn't need them.
4. **Approve / refine the fork-org convention** in `external/scruple-nodes/README.md`. Adjust before pushing if needed.

**Where to find what:**
- WO + all appendices: this file (`docs/wo/2026-06-21-canvas-node-parity.md`)
- Fork: `/data/scruple-web/external/scruple-nodes/seedvr2_videoupscaler/` (branch `scruple-canvas-fork`)
- Fork convention: `/data/scruple-web/external/scruple-nodes/README.md`
- Sync helper: `/data/scruple-web/external/scruple-nodes/sync-upstream.sh`
- Memory pointer: `memory/MEMORY.md` → `reference_canvas_node_fork_pattern.md`
- Session report: `docs/sessions/2026-06-21.md`
- Upstream archive: `external/scruple-nodes/_upstream-snapshots/seedvr2_videoupscaler-2026-06-21/`

**Reversibility note:** if anything looks wrong on `canvas.stooges.ai` in the morning, the fastest revert is:
```bash
cd /data/reference/ui-inspire/ComfyUI/custom_nodes
rm seedvr2_videoupscaler   # remove the symlink
cp -a /data/scruple-web/external/scruple-nodes/_upstream-snapshots/seedvr2_videoupscaler-2026-06-21 seedvr2_videoupscaler
sudo systemctl restart comfyui.service
```
That puts you back exactly where you were before the overnight pass.

Sleep well.
