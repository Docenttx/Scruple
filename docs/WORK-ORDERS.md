# WO series — Scruple Desktop Studio to L2

_2026-09-09, overnight. Read `docs/DESIGN.md` first — it carries the settled
decisions, and they are not open._

## Standing rails

- 🔴 **Never modify `/opt/scruple-witness`** — it serves `witness.scruple.ai`
  and is live. Never contact `127.0.0.1:5799` or `:3001` (`scruple.stooges.ai`,
  live and unsupervised). Your sandbox is the scratch witness on **5899**, the
  scratch app on **3902**, and the CVM surrogate on **8799**.
- 🔴 The surrogate is **SOFTWARE-backed**. A leaf it signed is `passthrough`,
  never hardware-backed, never `verified`. On a desktop profile `verified` is
  unrepresentable by construction — migration 053 refuses it at the database.
- **Electron is not installed.** Install it into this repo. There is no display:
  run it under `xvfb-run -a -s "-screen 0 1280x900x24"`, the pattern proven here
  for Blender. ⚑ **Screenshots come back blank** under llvmpipe — verified three
  ways against a detector proven on real renders. Never gate on pixels.
- **Verify by side effect.** Every gate names an observable AND a control that
  must not fire. Demonstrate each control RED before the change and green after.
  A green test with no control proves only that it cannot fail.
- Prefer Bash over Read/Edit/Write. Commit in this repo; do not push. If a gate
  does not pass, say so plainly and keep the work — do not narrow the WO to what
  happened to succeed.

---

## WO-D1 — It runs, headlessly, and we can see it

Get an Electron app starting under xvfb and prove the process is real.

Install Electron. Reduce `main-modular.js` to a shell that opens one
`BrowserWindow` pointed at the scratch Next app (`$SCRUPLE_APP_URL`). Add a
preload script exposing a minimal `window.scruple.ping()` over IPC.

**Gate:** `xvfb-run … electron .` starts, loads a page from `:3902`, and a
scripted `ping` round-trips main↔renderer. Record the Electron and Chromium
versions actually observed. **Control:** with the app pointed at a dead port the
run must FAIL rather than report success — show both.

## WO-D2 — The headless driver

Build `scripts/desktop-run.mjs`, the desktop mirror of Web Studio's
`scripts/scruple-run.ts` ("the same path a user hits, without the canvas").

It launches the real app under xvfb, drives a named scenario through the **real
IPC handlers**, and asserts on side effects — never on logs.

**Gate:** one command runs a scenario end to end and exits non-zero when the
scenario's assertion fails. **Control:** deliberately break the assertion and
show a non-zero exit; a driver that always exits 0 is not a driver.

## WO-D3 — The vault, rebuilt on the SDK

Keep the model from `app-legacy/lock/lock-local-lock.js`: enumerate a directory,
hash the set, treat it as a unit. Rebuild it as a **capture surface** on the
current SDK — the `ObservationSink` contract, not a hand-rolled client.

Replace, do not port: extension-branching (`.toml` / `.json` / `.safetensors`)
becomes **declared MIME**, refusing rather than guessing; unbounded
`readFileSync` becomes a **counted ceiling with a refusal outcome** recorded as
a fact; and the three measurement-honesty states apply.

**Gate:** a real directory of files produces leaves in the scratch witness whose
content hashes re-hash from the bytes on disk. **Controls:** a file with no
declared MIME is REFUSED, not defaulted; a file over the ceiling is refused **as
a recorded outcome**, not silently skipped. Show both refusing, and show an
ordinary file still accepted — a surface that refuses everything passes neither.

## WO-D4 — The gate in the path, and model fingerprints

Launch ComfyUI from the app with the capture gate in front of it, so the app
knows the upstream address, the model directory, and that nothing else is
listening on it.

Then close the gap that motivates this whole product: **fingerprint the models
from the local model store.** `modal/scruple_runner.py` already does this
(`_fingerprint_file`, `_hash_workflow_models`) by hashing files under the model
root — the code exists, it just needs somewhere to stand.

**Gate:** a generation driven through the gate produces a leaf carrying model
fingerprints computed from the **files**, not from the workflow's names.
**Control:** swap a model file's bytes while keeping its filename and show the
fingerprint changes — that difference is the entire product claim.

## WO-D5 — The UI, canon design on the shared implementation

Port the canon design — 21 tokens, the workspace and wallet layouts from
`app-legacy/renderer/styles/main.css` — **into the shared Next theme** in
`/data/scruple-web`. Do not restyle; carry the design across.

The dashboard renders from `GET /api/v2/capabilities`, so the same components
serve desktop and web and differ only in what the deployment reports.

**Gate:** the same route renders a desktop-shaped dashboard when capabilities
report local apps and a web-shaped one when they report Modal/RunPod. **Control:**
a region that does not apply must be ABSENT, not merely empty — a dashboard that
always draws everything cannot pass.

## WO-D6 — The ComfyUI hook, host-agnostic

Generalise the integration so Blender is consumer #1 rather than a special case.

**Level 1:** any host pointing its ComfyUI address at the gate gets capture with
no code from us — and a record that is honestly *semantically blind*.
**Level 2:** a registered host adapter supplies the meaning the gate cannot see.

Specify the registration: how a host declares itself, what an adapter must
implement against `surface.py`'s `ObservationSink`, and what a leaf says when a
host is at Level 1 versus Level 2.

**Gate:** register a **fake** host adapter and show its semantics reaching the
leaf. **Control:** the same generation with no adapter must produce a Level-1
leaf that says so — declared blind, not silently thinner.

## WO-D7 — Prove the whole thing, and close out honestly

Run the full flow through `desktop-run.mjs`: launch, gate, generate, vault-hash,
witness, receipt, C2PA against the surrogate.

**Gate:** at least 5 leaves; every artifact re-hashes from disk; every receipt
resolves; every basis reads `stale`/`passthrough` and **never** `verified`.
Print the table.

Then `docs/STATE.md`: what works and the observable that showed it, what is
built but unproven, what needs a human, and what needs the founder. Separate
"done" from "done against the surrogate". ⚑ State plainly that **Blender is not
installed in this app yet** — that is the next series, and this one is the floor
it stands on.
