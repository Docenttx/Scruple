# WO-W1 — Scruple Desktop Studio on Windows, honestly

_Written 2026-09-09 on the Linux build box, to be executed on the travel laptop._

## Why this exists

Everything in the D and E series was built and proven on Linux, headless, under
`xvfb` with llvmpipe. Three consequences shaped every gate:

- **no framebuffer** — screenshots come back blank, so nothing gates on pixels;
- **no GPU and no model weights** — the box has zero, so generations use a
  1,700-parameter fixture model;
- **`/proc` is always there** — two measurements read it directly.

A Windows laptop inverts all three. That makes it a genuinely different rig, not
a second copy of this one, and the point of this work order is to make the
difference **visible in the record** rather than to paper over it.

## The three Linux-only readings, named

| file | reads | on Windows |
|---|---|---|
| `app/comfy/ports.js` | `/proc/net/tcp`, `/proc/net/tcp6`, `/proc/<pid>/fd` — the port ledger that proves the gate is in the path | must report **`unavailable`, with a reason** |
| `app/comfy/namespace.ts` | `/proc/<pid>/ns/*`, `/proc/<pid>/status` — the isolation measurement behind finding D4-1 | must report **`unavailable`, with a reason** |
| `scripts/desktop-run.mjs` (~line 1663) | hardcodes `xvfb-run` | must not wrap when a display exists |

🔴 **`unavailable` is not the same as `false`, and neither is `null`.** WO-D5
established three states for a host fact — **measured / unavailable / refused** —
and this is exactly what they are for. A Windows build that reported
`enforcementPresent: false` would be asserting a measurement it did not make.
A Windows build that omitted the field would be indistinguishable from a build
that never had the feature. Report `unavailable` and say why.

⚑ A Windows equivalent of the port ledger (`GetExtendedTcpTable`, or parsing
`netstat -ano`) is **welcome but out of scope here**. Getting the honest
degradation right first means the port ledger can be added later without any
other code learning it used to be missing.

## What to build

1. **Platform-honest host facts.** The three readings above degrade rather than
   throw. Every degradation carries a machine-readable reason.
2. **The driver runs without `xvfb`.** `desktop-run.mjs` detects a display and
   skips the wrapper; the same scenario JSON runs unchanged on both platforms.
3. **A `click` step.** The driver currently dispatches IPC calls and reads the
   DOM. Add a step that synthesizes a real DOM event on a selector and then
   asserts the side effect — so a scenario drives the UI the way a user does,
   not the way the bridge does.
4. **Screenshot capture, finally.** On a real framebuffer a screenshot is a real
   observable. Add it as an **artifact the driver stores**, NOT as an assertion:
   a picture is evidence for a human, and no gate should pass or fail on pixel
   comparison. (Everything in this codebase that gates on an image would be new
   and unproven; do not start now.)

## Gate

The **same scenario file** — `scenarios/ping.json` and `scenarios/vault-capture.json`,
unmodified — passes on Windows and on Linux, and the platform-specific facts
differ **exactly where the table above predicts and nowhere else.**

## Controls, all required

- **A diff of the two runs' host-fact blocks** must show the three degraded
  readings and nothing else. A fourth difference is a finding, not a tolerance.
- **The `unavailable` states must be shown to be reachable AND distinguishable**:
  a fact that is genuinely unavailable, one that is refused, and one that is
  measured, in the same run, reading differently.
- **`click` must be shown to fail** when pointed at a selector that is absent —
  a click step that silently no-ops proves nothing about the button.
- **The screenshot must be shown to be non-blank** on this platform, against the
  detector already proven on real renders (see `docs/DESIGN.md`). If it comes
  back blank on Windows too, that is the finding and the WO says so.

## Report

`docs/FINDINGS-WIN.md`, in the same shape as `docs/FINDINGS.md`: one entry per
thing that is true about the Windows build and not visible from a green gate.
Windows path semantics — separators, drive letters, case-insensitivity, the
260-character limit, reserved names — are the most likely source, because the
vault enumerates directories and hashes what it finds. **Nothing here has ever
run against a case-insensitive filesystem.**
