# Findings carried forward — Windows

_Things that are true about the Windows build and are not visible from a green
gate. Same shape as `docs/FINDINGS.md`, kept separately because "the gate passed
on Linux" and "here is what Windows does differently" are different sentences._

**Rig, measured 2026-09-10.** Windows 11 Pro 10.0.26200 x64 · i7-8650U (4C/8T
@1.9GHz) · 16 GB · Intel UHD 620 integrated, no discrete GPU · real 1920x1080
display · git 2.55.0.windows.3 · **node 24.19.0** · npm 11.17.0 · electron
38.8.6 (chrome 140.0.7339.249) · python 3.11.9 · Blender 4.2.16 LTS.

⚑ **The Node version is a declared difference, not a tolerance.** The build box
runs node v20.20.2 / python 3.10.12 / Blender 4.2.23 LTS. Node 24 is kept
deliberately — pinning this rig to 20 would make it measure the build box twice
instead of measuring what a Windows user actually has. Any host-fact difference
plausibly attributable to the runtime version must be **attributed as such**, not
folded into "expected platform difference". Version-attributable and
platform-attributable are different facts with different owners.

---

## W1-0 — the blank detector `DESIGN.md` calls "proven" is not in the repo

`docs/DESIGN.md` says a screenshot on the build box "will be blank — llvmpipe's
framebuffer readback returns a uniform image — three approaches were tried
against Blender and **a detector proven on real renders**." That detector is not
in `scruple-desktop`, not in `scruple-web`, and not in the addon tree. It was ad
hoc on the build box and did not survive into the shared record.

This matters more than a missing utility. The build box's instruction for this
rig was to run captures "past the blank detector — the one `docs/DESIGN.md`
records as proven against real renders." Following that instruction literally is
impossible, and following it loosely — writing a fresh detector and calling its
output proven — would inherit a credential the new code has not earned.

**What was done instead.** `scripts/win/blank-detector.mjs` is a
re-implementation, explicitly new and explicitly unproven, with `--selftest`
controls that run **in the same process, immediately before** any real verdict.
If a control fails, `scripts/win/score-capture.mjs` exits 3 and issues no verdict
at all. The five controls and what each one buys:

| control | expected | proves |
|---|---|---|
| uniform black | BLANK | the detector *can* say BLANK — without it, NON-BLANK is unfalsifiable |
| uniform white | BLANK | blankness is flatness, not darkness |
| uniform mid-grey | BLANK | no dependence on the fill value |
| gradient + box | NON-BLANK | the detector *can* say NON-BLANK — without it, it might call everything blank |
| uniform + **one** differing pixel | NON-BLANK | sensitivity floor: 99.995% flat is still not uniform |

All five pass. The detector reads **raw BGRA bytes, never a PNG** — decoding
would put an image codec between the framebuffer and the measurement, and the
codec is not what is under test.

**What needs a decision.** Either this detector is promoted to the shared tree
and the build box's Blender work re-scored against it, or `DESIGN.md` should stop
describing a proven detector that no longer exists.

## W1-1 — screenshots are a real observable on this rig, measured

The headline difference between this rig and the build box, and it is now a
measurement rather than an assumption.

| capture | source | verdict | luminance stddev | distinct colours |
|---|---|---|---|---|
| desktop, display forced awake | `CopyFromScreen` (primary screen, 1920x1080) | **NON-BLANK** | 34.56 | >=4096 |
| Electron, content page, visible window | `capturePage().toBitmap()` | **NON-BLANK** | 42.29 | >=4096 |
| Electron, **deliberately uniform page**, visible window | `capturePage().toBitmap()` | **BLANK** | 0 | 1 |
| Electron, content page, `show:false` window | `capturePage().toBitmap()` | **NON-BLANK** | 42.29 | >=4096 |

⚑ **The third row is the one that makes the other three mean anything.** A
`capturePage` that returned uninitialised memory, a fixed test pattern, or the
desktop behind the window would also have scored NON-BLANK on real content. So a
page painted edge to edge in a single colour (`#3a3a3a`) was captured through the
identical path and is **required** to come back BLANK. It does: stddev exactly 0,
exactly 1 distinct colour, mean luminance exactly 58 — which is `#3a3a3a`. Only
because the two disagree in the predicted direction is `capturePage`
demonstrably reading this window's own pixels.

So on this rig a screenshot is a genuine observable, measured 2026-09-10 with the
display forced awake. **It remains an artifact and not an assertion** — WO-W1 is
explicit that nothing gates on pixels, and nothing here does.

## W1-2 — `show:false` captures are byte-identical to visible ones

The content page captured from a visible window and from a `show:false` window
produce the **same SHA-256**: `c1334d34ca561456f5bd6d253fd62920302efe6e720ce3523b74a387b5b06a1b`.

This is the good outcome for the build box's warning about a run that is
"headless in practice while believing itself headed" — window visibility does not
silently degrade what the driver would store. It also means a scenario cannot
detect window visibility by inspecting its own screenshot, so anything that needs
to depend on visibility must measure it directly rather than inferring it from
pixels.

## W1-3 — a screenshot's dimensions match neither the window nor `getContentSize()`

`capturePage()` returns **physical** pixels. On this rig:

| quantity | value |
|---|---|
| requested window | 1000 x 700 |
| `win.getBounds()` | 1001 x 701 |
| `win.getContentSize()` | 988 x 645 |
| **capture size** | **1275 x 833** |
| `screen.getPrimaryDisplay().scaleFactor` | **1.29** |
| capture / content ratio | 1.2905 x 1.2915 |

The capture is the *content* size multiplied by the display scale factor. Any
assertion of the form "the screenshot is 1000x700" — or any comparison of a
Windows screenshot's dimensions against a Linux one — is wrong for a reason that
has nothing to do with the app.

⚑ **Two Windows APIs disagree about the size of the same display.**
`System.Drawing` / `System.Windows.Forms` in Windows PowerShell 5.1 report the
primary screen as 1920x1080 at DpiX 96 (scale 1.0). Electron reports the same
display as **1489 x 838 at scaleFactor 1.29**. Both are "correct" — they are
physical and logical coordinates respectively — but a check that reads geometry
from one and compares it against the other will be wrong by 29% and will look
like a rendering fault.

## W1-4 — Windows PowerShell 5.1 `Out-File -Encoding utf8` writes a BOM, and `JSON.parse` rejects it

Hit while building the capture harness, and it will be hit again by anything on
this platform that hands JSON from PowerShell to Node. `-Encoding utf8` in
Windows PowerShell 5.1 means *UTF-8 with BOM*; Node's `JSON.parse` fails on the
leading U+FEFF with `SyntaxError: Unexpected token '﻿'`, pointing at column 1 of
a file that looks perfectly valid in every editor.

`New-Object System.Text.UTF8Encoding($false)` with
`[System.IO.File]::WriteAllText` is the BOM-less writer.
`scripts/win/capture-desktop.ps1` carries the note inline.

## W1-5 — Electron: a window created after `destroy()` can fail to load. Two platforms, three sightings

⚑ **Promoted from UNRESOLVED.** Filed first as a not-a-finding on one sighting;
the build box then reproduced it **on Linux** on the first run of its own probe —
window 1 loaded and captured, `destroy()`, window 2 → `ERR_FAILED (-2)` on load.
Same symptom, different OS, different Electron invocation, and creating all
windows up front fixed it there exactly as here. Two independent reproductions on
two platforms make it an Electron behaviour rather than a quirk of this machine.

**Still not understood, and the workaround is not a fix.** Original text below,
kept because the eliminated hypotheses are the useful part.

While building the framebuffer probe, creating a `BrowserWindow` immediately
after `destroy()`ing the previous one failed twice, with two different symptoms:
once `ERR_FAILED (-2)` on the next `loadFile`/`loadURL` (raised via
`stopLoadingListener`, on both `file:` and `data:` URLs), and once a **silent
process exit** that printed neither the success line nor the `catch` block's
error.

The obvious explanation — Electron quits when the last window closes and no
`window-all-closed` handler was registered — was tested and is **wrong**.
`scripts/win/window-lifecycle-probe.cjs` runs create → destroy → create in four
configurations (`show:false` and visible; `about:blank` and real content; with
and without the handler; `capturePage()` before the destroy) and
**create-after-destroy succeeds in all four**.

So the cause is unknown and the failure is not currently reproducible. The probe
is committed so the next person starts from four eliminated hypotheses rather
than from zero. `scripts/win/fb-probe-main.cjs` creates all windows up front —
chosen because it is the arrangement observed to work, not because the failure is
understood, and its comments say so.

## W1-6 — the port ledger asserted `count: 0` and `allLoopback: false` on a box where nothing was measured

The WO-W1 headline, and worse in practice than the work order's wording suggests.

Every read in `app/comfy/ports.js` was wrapped in `catch { return [] }`. On
Windows that is not a degraded measurement, it is a **false** one:

| field | old value on Windows | what it asserts | what was true |
|---|---|---|---|
| `gate.count` | `0` | nobody is listening on the gate port | nobody looked |
| `gate.allLoopback` | `false` | the gate is not loopback-bound | — |
| `upstream.allLoopback` | `false` | **ComfyUI is reachable without passing the gate** | — |

That last row is the ledger's whole reason for existing. `ports.js` says an
upstream on `0.0.0.0` means "every byte taken that way leaves through no gate and
gets no leaf" — and a missing file manufactured exactly that reading. The same
holds for `app/comfy/namespace.ts`, where the catch blocks produced
`enforcementPresent: false`, which is finding **D4-1's entire substance**. D4-1
would have appeared to reproduce on a machine that measured nothing.

**Now:** `state` (`measured` · `unavailable` · `refused`) on the ledger and on
each side, `reasonCode` + `reason` on every degraded reading, and **`null` — never
`false`, never absent — for every count and boolean that was not measured.** No
field was dropped: an omitted field is indistinguishable from a build that never
had the feature.

`unavailable` and `refused` are kept apart deliberately. Absent procfs (`ENOENT`)
is a fact about the platform that no permission change can fix; unreadable procfs
(`EACCES`/`EPERM`) is a fact about this run that changing who runs it would fix.
Collapsing them would lose the only actionable half.

**Controls, all demonstrated** — `node scripts/win/host-facts-control.mjs`, exit 0:

- all three states reachable and reading differently **in one run** (a readable
  temp file, an absent path, and a file under a deny ACL);
- **RED before, GREEN after, against the real previous implementation** rather
  than against a mutation of the new one — the old code is reproduced verbatim in
  the control and shown producing `count: 0` / `allLoopback: false` on this
  machine, beside the new code producing `null` and a reason;
- all 18 fields a consumer reads still present on both sides of the ledger.

⚑ **What this breaks, honestly.** `scenarios/comfy-generate.json` asserts
`ledger.gate.count == 1`, `allOwnedByExpected == true`, `allLoopback == true`.
Those assertions **cannot pass on Windows** and must not be made to. A Windows
port ledger (`GetExtendedTcpTable`, or parsing `netstat -ano`) is the fix and
WO-W1 explicitly puts it out of scope; until then that scenario is Linux-only,
and saying so is the honest outcome rather than relaxing the assertion.

## W1-7 — `access(R_OK)` cannot see a Windows ACL, so `refused` would have read as `measured`

Found while building the control above, and it would have silently defeated the
distinction W1-6 exists to draw.

The first implementation probed readability with `fs.accessSync(file, R_OK)`. On
Windows `access()` reports on file **attributes** and largely ignores ACLs, so a
file this process is forbidden to read still answers "readable" — turning a
`refused` into a false `measured`, which is precisely the class of error being
fixed. `ports.js` now proves readability by **opening the file**, which is what
the caller is about to do anyway and is the only answer that cannot be wrong.

The control demonstrates this with a real deny ACL applied via `icacls`, and
scores itself INCONCLUSIVE (not a pass) if the ACL cannot be applied.

## W1-8 — the driver's database default is a build-box absolute path, and every scenario pays it

`scripts/desktop-run.mjs` defaults `SCRUPLE_DB_PATH` to
`/mnt/corpus/scruple-council-impl/scruple-scratch.db` in two places
(`iterationsWatermark`, `countIterationsLike`). Nine gate scripts carry the same
default for that path and for `witness-scratch.db`.

**Same defect class as the `/data/scruple-web` symlink**: a path that exists on
exactly one machine, baked in as the fallback, working there and nowhere else.
The env var makes it overridable, which is why it has never been felt.

⚑ **`iterationsWatermark()` runs unconditionally in `runOnce`**, so it throws
before the app is launched — for *every* scenario. `scenarios/ping.json`, whose
entire job is to prove the IPC seam answers, cannot run without `sqlite3` on PATH
and a scratch database with an `iterations` table. The simplest scenario in the
suite is coupled to the witness database. Observed verbatim:

```
Error: iterations watermark query failed against
  /mnt/corpus/scruple-council-impl/scruple-scratch.db: spawnSync sqlite3 ENOENT
```

The driver also shells out to `curl`. Windows ships `curl.exe`, so that one is
fine; `sqlite3` is not present and had to be installed.

## W1-9 — `better-sqlite3` cannot install under Node 24 on Windows, and it is the declared Node delta, not the platform

`npm install` in `scruple-web` fails: `better-sqlite3@11.10.0` has no prebuilt
binary for Node 24 on win32, falls back to `node-gyp`, and dies with
`Could not find any Visual Studio installation to use` — the fix for which is a
multi-GB C++ toolchain.

**Attributed, not folded in.** The build box asked that any difference plausibly
caused by the Node version be named as such rather than absorbed into "expected
platform difference". This is one, and it was tested rather than assumed: the
identical install under a portable **Node 20.20.2** — the build box's version, no
system change, nothing added to PATH — **succeeds in 22 s and fetches a prebuilt
`better_sqlite3.node` with no compiler involved.**

So: `better-sqlite3` version-attributable ✓, platform-attributable only in the
weaker sense that a missing prebuild costs a C++ toolchain on Windows where Linux
usually already has `gcc`. A Windows user on Node 20 hits nothing here.

