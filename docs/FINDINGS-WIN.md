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

## W1-5 — unresolved: two post-`destroy()` window failures that will not reproduce

Recorded because it cost real time and may cost it again, **not** as a platform
finding.

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
