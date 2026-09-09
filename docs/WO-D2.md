# WO-D2 — the headless driver

_2026-09-09. Gate: `bash scripts/d2-gate.sh` (needs the scratch app on `:3902`)._

## What was built

| file | what it is |
|---|---|
| `scripts/desktop-run.mjs` | **the driver.** Launches the real app under xvfb, drives a scenario, grades it on side effects. |
| `scripts/d2-gate.sh` | gate + sweeps + its three controls, one command. |
| `app/scenario.js` | the main-process half: dispatches each step through the renderer, records, grades nothing. |
| `app/interpolate.js` | `${...}` resolution, shared by both halves so they cannot disagree. |
| `app/ipc-capture.js` | `scruple:capture-file` — the single-file primitive, the first handler with a side effect outside the process. |
| `app/page-ready.js` | `waitForLoad`, extracted from `probe.js` so D1's probe and D2's runner agree what "loaded" means. |
| `scenarios/ping.json` | WO-D1's round trip, re-expressed. |
| `scenarios/capture-file.json` | bytes on disk that re-hash to the recorded content hash. |

## The mirror

`scruple-web/scripts/scruple-run.ts` "runs a workflow through the real
`/api/runs` endpoint — the same path a user hits — without the canvas". Web
Studio's user path is an HTTP route, so its driver is a `fetch`. Desktop
Studio's user path is a click in a window that reaches the main process over
IPC, so this driver launches the real app and drives the whole way round:

    driver → xvfb-run electron . --scenario=spec.json
           → renderer → window.scruple.<call> → ipcRenderer.invoke
           → ipcMain.handle → main → back

Nothing calls a handler function directly in main. That would be quicker and
would prove nothing about the seam.

## The app grades nothing

`app/scenario.js` writes `result.json` saying what it did. **That file is a
claim.** Every assertion is evaluated in the driver process, against the world
the app left behind: bytes read off disk and hashed there, an exit code, a nonce
the driver minted. Nothing is asserted from a log line, and nothing from a pixel
— docs/DESIGN.md is explicit that llvmpipe returns a blank frame.

The app's exit code says only *the scenario ran to the end* (new code **5** when
it did not, distinct from D1's 3 and 4). Passing is the driver's verdict.

## Writing a scenario

A scenario is JSON: `fixtures` the driver materialises and hashes before launch,
`steps` dispatched through the bridge, `assert` evaluated afterwards by the
driver, and `audit` declaring what each break must do.

    { "fixtures": { "src": { "name": "capture-me.bin", "bytes": 65536, "seed": "…" } },
      "steps":  [ { "as": "cap", "call": "captureFile", "args": [{ "path": "${fixtures.src.path}" }] } ],
      "assert": [ { "id": "store-rehashes", "kind": "file-rehashes",
                    "path": "${steps.cap.value.storePath}", "sha256": "${steps.cap.value.sha256}" } ],
      "audit":  { "store-truncate": ["store-rehashes", "store-bytes"] } }

Assertion kinds live in `KINDS` in the driver: `app-completed`, `equals`,
`at-least`, `non-empty`, `ends-with`, `step-succeeded`, `reached-main`,
`file-exists`, `file-absent`, `file-rehashes`, `file-bytes`. A row in the
witness and a receipt that resolves are the next two, and they go here.

## The sweep

A green run against an app nobody has broken is likelier to mean the assertions
are weak than that the app is right — `scripts/probe-harness/run.sh` already
applies that principle on the server side. `--audit` breaks the run once per
mutation and requires each break to redden **exactly** the assertions the
scenario declared, in its own `audit` block, written before the run. More red
than declared means an assertion is coupled to something it should not care
about; less means it does not test what it claims. Both are findings.

Twelve mutations across the two scenarios, all caught. What stays GREEN is the
part worth reading:

- **`source-swap` leaves `store-rehashes` green.** The app's copy is honestly the
  digest of what the app read; only the comparison against the driver's own
  earlier hash notices the file changed underneath it. That is why both
  assertions exist — and it is the shape of WO-D4's control.
- **`fake-bridge` leaves `store-exists` and `store-bytes` green.** A
  renderer-side liar returning the *source* path satisfies both. That is what "a
  file is there and it is the right size" is worth on its own.
- **`fake-bridge` leaves `echoes-driver-nonce` green**, restating WO-D1: a stub
  can echo whatever it is handed. The nonce minted in main is the evidence.

### It found a defect in the driver

Under `no-bridge` there is no reply to read a version out of, and
`reports-electron-version` passed anyway: `ctx.resolve` caught the
interpolator's deliberate throw and returned the placeholder string
`"<<unresolved: …>>"`, which is non-empty. An unresolvable reference is now a
failed assertion, never a satisfied one. The expectation was declared first and
the run disagreed with it; fitted to the observed output instead, this would
have been filed as correct behaviour.

## Gate and controls

| run | result |
|---|---|
| `ping`, `capture-file` | PASS, exit 0 |
| both `--audit` sweeps | 12 mutations, each caught by exactly what it targets |
| **A** `--break assert-expectation` | exit **1**, exactly one red |
| **B** dead port `:39027` | exit **1**; `source-unchanged` stays green, so the failure is the app's, not the harness's |
| **C** a passing run given `--expect-fail` | exit **1** — the inversion cannot launder a green run |

`bash scripts/d1-gate.sh` is still green; `probe.js` and `preload.js` changed.

## What this deliberately does not do

`scruple:capture-file` keeps the part WO-D3 keeps — a counted read, and a digest
of the bytes actually read rather than of the bytes the caller believed were
there. It has **none** of D3's policy: no declared MIME, no ceiling, no refusal
recorded as a fact, no directory. Inventing those here would mean writing them
twice.

No scenario reaches the witness yet. ⚑ The scratch witness on `:5899` is running
with leaf signing **disabled** (`curl :5899/api/signer` → `"mode":"disabled"`)
because the overnight runner's bring-up only checks `/health`. WO-D7's gate
wants every basis to read `stale`/`passthrough`; with signing off it reads
neither. The `kms-http` command that points it at the surrogate is in
`/mnt/corpus/scruple-blender-l2/SANDBOX-NOTES.md`. It was not restarted here —
that is a sandbox change the work order that needs it should make deliberately.
