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

⚑ The same ABI wall appears a second way: a prebuild fetched for Node 20 is
`NODE_MODULE_VERSION 115` and **cannot be loaded by Node 24** (`137`). Since the
vault sidecar reaches the SDK through `vendor/scruple-web/node_modules`, the
whole SDK path is unusable under Node 24 unless `better-sqlite3` is rebuilt for
it. The driver was run under Node 20 for that reason, and this is recorded rather
than papered over because it means **this rig cannot currently exercise the SDK
path on the Node version a Windows user would actually install today.**

## W1-10 — 🔴 `file:$DB?mode=ro` silently opens the WRONG database on Windows, and reads as a provenance failure

The most dangerous finding of the night, because it fails green-adjacent: not
with an error, but with an empty answer that looks like missing provenance.

`scripts/desktop-run.mjs` and nine gate scripts build a SQLite URI by
concatenation — `file:` + the path + `?mode=ro`. Measured on Windows 11 with
sqlite 3.53.4, against a database that exists and has rows:

```
$ sqlite3 "file:C:\SCRUPLEWORK\.scratch\scruple-scratch.db?mode=ro" \
    -batch "SELECT COUNT(*) FROM iterations;"
Parse error: no such table: iterations
$ ls
=ro          <-- a file named `=ro`, 0 bytes, created in the CWD
```

Three things went wrong and each makes the next worse:

1. SQLite does not treat `C:\...` as absolute after `file:`, so the real database
   is **never opened**;
2. `?mode=ro` is **never parsed as a query parameter** — a file literally named
   `=ro` is created in the working directory;
3. because `mode=ro` was never applied, the open **succeeds** against that new
   empty database, so there is no error to notice.

Every query then returns nothing or `no such table`. **A witness lookup for a
leaf that was genuinely written comes back "not found."** In a codebase whose
entire claim is that leaves can be found and re-hashed, a path bug is
indistinguishable from the provenance failure it imitates.

Forward slashes alone do **not** fix it; the URI needs the `file:///` form.
Verified correct: `file:///C:/SCRUPLEWORK/.scratch/scruple-scratch.db?mode=ro`
opens the real database **and** enforces read-only — a `CREATE TABLE` against it
fails with `attempt to write a readonly database`, which the broken form never
did.

**Fixed** in `scripts/desktop-run.mjs` via `sqliteUri()`, applied at all six call
sites. ⚑ **The nine `.sh` gates still build the broken string in bash** and are
untouched — they are Linux-only today, where the form happens to work, but the
exposure is identical the moment one runs here.

## W1-11 — `scripts/tsx.sh` cannot run on Windows at all, for two separate path reasons

`bash scripts/tsx.sh` is how every TypeScript entry point in this repo runs,
including the vault sidecar. Under Git Bash it failed twice, and both are MSYS
path-translation facts worth knowing:

1. **Arguments to a native binary get rewritten.** `node.exe` is a native Windows
   program, so MSYS converts POSIX-looking argv on the way in: `/c/SCRUPLEWORK/...`
   arrives as `C:/SCRUPLEWORK/...`. Node's ESM loader then rejects it —
   `ERR_UNSUPPORTED_ESM_URL_SCHEME: ... Received protocol 'c:'`. `--import` needs
   a real `file:///` URL, which is also immune to the rewriting because it does
   not begin with `/`.
2. **Environment variables are NOT rewritten.** `NODE_PATH` and
   `TSX_TSCONFIG_PATH` must be converted explicitly with `cygpath -m`, or
   `node.exe` receives POSIX paths it cannot resolve.

Fixed in `tsx.sh`, guarded on `command -v cygpath` so POSIX behaviour is
byte-identical.

Related, smaller: **`bash` is required but not on PATH.** Git for Windows ships
it at `C:\Program Files\Git\bin\bash.exe` and does not add that directory to
PATH (only `Git\cmd`). Nine gate scripts and `tsx.sh` need it.

## W1-12 — the sandbox recipe has an undocumented step that kills the server mid-run

Not Windows-specific, but it cost an hour and the symptom actively misleads.

The Next server **exits deliberately** the first time `/api/v2/components/provision`
is hit without `SCRUPLE_BDK_HEX` or `SCRUPLE_BDK_ALLOW_DEV` set *on the server
process*. The ratchet's refusal is correct and well argued — "a BDK invented at
boot silently invalidates every already-provisioned component" — but the failure
surfaces on the **client** as `provisioning failed: TypeError: fetch failed`,
which reads as a network problem, and the server is simply gone afterwards.

`d3-gate.sh` exports `SCRUPLE_BDK_ALLOW_DEV=1` for the *gate*, but the server is
started separately and out of band; nothing in the reading order says the server
needs it too. I diagnosed this wrongly twice first — blaming background-process
stdin EOF — before reading the server's own stderr, which says exactly what is
wrong and offers the escape hatch.

## W1-13 — ~~`vault-capture` cannot fully pass~~ **WITHDRAWN — I was wrong, and the way I was wrong is the finding**

🔴 **This entry originally concluded that `vault-capture` was not self-hosting and
could not pass on this rig. That was false.** The witness server IS in the repo,
IS self-hostable, and `vault-capture` now passes **25 of 25 on Windows,
unmodified**, with its full audit sweep green (7 mutations, each reddening
exactly what it targets).

**The recipe**, which nothing in the reading order mentions:

```
cd services/witness-server && npm install
PORT=5899 DB_PATH=<scratch>.db SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1 node server.js
# then point the Next server at it:  WITNESS_SERVER_URL=http://127.0.0.1:5899
```

It creates its own schema (`CREATE TABLE IF NOT EXISTS witnesses`, server.js:111),
needs no Stripe key and no Arweave key at startup, and warns loudly that it is
sealing with a forgeable dev secret — which is correct for a rig.

**Why I got it wrong, since that is the reusable part:**

1. **I searched for the wrong variable.** `SCRUPLE_WITNESS_DB` is read by the
   desktop driver and the gates; the witness server writes the file it is given
   in **`DB_PATH`**. Grepping the former across all three trees returns only
   readers, which looks exactly like "nothing writes this."
2. **I read a deployment note as a prohibition.** `server.js`'s header says it is
   "Deployed at /opt/scruple-witness/server.js on Oracle VM… port 5799", and
   `WORK-ORDERS.md` forbids touching that path. I concluded the file *was*
   production rather than the *source of* production. The build box confirms the
   repo copy is byte-identical to the deployed one — which makes it runnable
   here, not untouchable.
3. **`npm install` inside that directory is a step nobody names.** `arweave` is
   not in `scruple-web`'s root `node_modules`, so the module resolution failure
   I would have hit reads as "this is not meant to run from here."

⚑ **The general lesson, and it is the same shape as W1-B4 and W1-9:** "I could
not find the thing that writes X" is a statement about my search, not about the
repository, and it is worth one more attempt at falsification before it becomes a
finding. Filing a *cannot* is a strong claim and needs the same evidentiary
standard as filing a defect. The correct move — asking the build box how they
stand up their scratch witness — took one message and resolved it immediately.

**A genuine finding does survive from this**, see W1-15 below.

---

### Original entry, retained because the reasoning is what went wrong

## ~~W1-13 (superseded)~~ — `vault-capture` cannot fully pass on any machine that only has these three repos

**20 of 25 assertions pass on Windows**, including `outcome-vaulted`,
`manifest-exists`, `manifest-rehashes`, all three refusals (`undeclared-refused`,
`declared-absent-refused`, `oversize-refused`), `two-captured`, `five-files-seen`
and `queue-drained`. The vault surface itself works on Windows.

The 5 that fail are all the same assertion shape — `*-in-witness` — and all fail
for one reason: **`SCRUPLE_WITNESS_DB` is only ever READ.** Nothing in
`scruple-desktop`, `scruple-web` or the addon tree writes a `witnesses` table.
The build box has a scratch witness service at `/mnt/corpus/...`; it is not in
any of the three repos, so the scenario is **not self-hosting**.

The only `witnesses`-schema server in the tree is
`services/witness-server/server.js`, whose own header says it is deployed at
`/opt/scruple-witness` on the Oracle VM, port 5799 — the host `WORK-ORDERS.md`
forbids touching. It also wants Stripe, Arweave and IPFS. Standing up a copy was
**not** attempted.

🔴 **This is a gate that cannot pass, not a gate that failed.** Reporting it as a
Windows defect would be false; narrowing the scenario to the 20 assertions that
do pass would be exactly the "narrow the WO to whatever succeeded" the rails
forbid. What is needed is the scratch witness's provenance, from the build box.

_(End of superseded entry. The last sentence was right and is how it was
resolved — asking cost one message. The conclusion above it was wrong.)_

## W1-15 — the witness server binds `0.0.0.0`, on a laptop that travels

`services/witness-server/server.js:1564` — `server.listen(PORT, '0.0.0.0')`.

Not loopback. Every network the laptop joins can reach the sandbox witness, and
that witness is running with `SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1`, meaning **every
leaf it seals is forgeable by anyone who can reach it.** On the build box —
a fixed Linux host behind whatever its firewall is — this is a much smaller fact
than it is on a travel laptop on hotel and café networks.

⚑ There is an irony worth stating plainly: `app/comfy/ports.js` exists to detect
exactly this shape. Its own header says an upstream on `0.0.0.0` "is a ComfyUI
anything on the network can reach directly, and every byte taken that way leaves
through no gate and gets no leaf." The port ledger would flag this — and on
Windows the port ledger is `unavailable` (W1-6), so **the one measurement that
would have caught it is the one this platform cannot take.**

Not changed here: the bind address is the server's decision and altering it is
outside WO-W1. Recorded so that whoever runs this rig outside a trusted network
knows to bind loopback or firewall the port first.

**Confirmed on Linux by the build box**, and it is sharper there because both
services are visible at once:

```
0.0.0.0:5899   LISTEN   <- the witness, sealing with the FORGEABLE dev secret
127.0.0.1:8799 LISTEN   <- the CVM surrogate, correctly loopback
```

The surrogate gets this right and the witness does not, on the same box in the
same sandbox — so it is an inconsistency inside one design, not a house style.

**Measured on this rig**, because "exposed" and "reachable" are different facts
and the difference should not be assumed either way:

| | measured |
|---|---|
| socket bind | `0.0.0.0:5899`, via `Get-NetTCPConnection` |
| firewall profiles | Domain / Private / Public all **enabled** |
| default inbound action | `NotConfigured` → Windows default is deny |
| rules for `node.exe` | **two ALLOW inbound rules**, enabled, Public profile, **LocalPort: Any** |

🔴 **There is no mitigation. The port is reachable.** Windows created inbound
**Allow** rules for the Node binary running the witness — any local port, Public
profile — so the default-deny does not apply to it. A forgeable-secret witness on
`0.0.0.0` is reachable from the Public-profile network.

⚑ **I reported the opposite first, and the error is worth recording.** An earlier
revision of this entry said "two **Block** inbound rules… inbound is blocked at
the host." That came from piping `Get-NetFirewallApplicationFilter` results into
`Get-NetFirewallRule`, which mis-associated filters with rules and returned the
wrong rules' actions. Two later queries — iterating rules and reading each rule's
own filter, then `netsh advfirewall firewall show rule name=all dir=in verbose` —
agree with each other and disagree with the first.

The lesson is the same one as W1-B4, W1-13 and the W1-17 retraction, and this is
its fourth appearance: **the instrument was confidently wrong and the wrong answer
was the reassuring one.** A mitigation that does not exist is worse than a known
exposure, because it stops anyone looking again. Two independent methods now
agree; the first method is not used anywhere in this document.

_On this particular machine the exposure is moot — the operator confirms it is
isolated and cleared for this work. The finding stands for anyone running the rig
elsewhere, and the bind is still the thing to correct._

⚑ The build box's proposed fix is better than a `BIND` variable defaulting to
loopback, and worth recording here because the reasoning generalises: a variable
can be set wrongly. Instead, **when `SCRUPLE_WITNESS_ALLOW_DEV_SECRET` is set the
server should refuse to bind anything but loopback**, whatever else it is told —
so the forgeable mode cannot be exposed rather than merely defaulting to
unexposed, and an operator who wants a dev witness on a LAN has to stop asking
for the forgeable secret first. That is the right order for those two decisions.

## W1-17 — the host-fact diff, both halves, and one thing neither platform can see alone

The build box ran `win/w1` @89c1021 on Linux. `ping.json` passes **12/12 there
too**, so the WO-W1 gate now has both halves for that scenario, and
`check-vendor-link.mjs` runs clean on their clone (61 files, 27 references, 0
unresolved — 61 rather than my 56, which is their tree having files mine does not).

| reading | Linux | Windows |
|---|---|---|
| `ports.js` `state` | `measured` | `unavailable` |
| `/proc/net/tcp`, `/proc/net/tcp6` | both `measured` | both `unavailable`, code `procfs_absent` |
| `namespace.ts` `state` | `measured` | `unavailable` |
| launcher | `xvfb-run` wrapper | direct, `launch.json` records why |

**Same key structure on both sides.** The build box confirms nothing was dropped
and no measured value moved — the additive `state`/`reasonCode`/`reason` fields
appear on the measured path too. That is what makes this a diff rather than a
reformat: the difference is in the *values*, at keys that exist identically on
both platforms.

### ~~The Linux port ledger returns empty from outside the gate's process~~ — RETRACTED

An earlier revision of this entry said the Linux run showed `portLedger()`
returning an empty ledger from outside the gate's process, and concluded that
"the Linux side of *the port ledger is a real measurement* is weaker than
assumed." **That is retracted. It was a harness bug in the probe, not a property
of the ledger.**

`portLedger` destructures an **object** — `{ gatePort, gatePid, upstreamPort,
upstreamPid }` — and was called with an **array** of ports. Every field came out
`undefined`; `listenersOn([undefined])` computes `wanted = Set([NaN])`, which
`wanted.has(r.port)` can never match; the result was an empty ledger. Confirmed
by reading `app/comfy/ports.js:107-113`, not by taking the correction on trust.
Called correctly against the same live sockets on this branch on Linux:

```
gate(5899)      state=measured  listeners=1  ["0.0.0.0 pid=3885472"]
upstream(3902)  state=measured  listeners=1  ["0:0:0:0:0:0:0:0 pid=3757722"]
```

The Linux port ledger is a real measurement from outside the gate's process. The
sweep this entry recommended is void: `portLedger` is called from exactly two
places, both in `app/ipc-comfy.js`, both in the main process, and no gate or
scenario asserts on an out-of-process ledger.

### ⚑ What survives is a better finding than the retracted one

The `state: 'measured', count: 0` versus `state: 'unavailable', count: null`
distinction stands on its own merits — it just is not load-bearing for the reason
first given.

And the mistake that produced the false alarm is itself the finding: **a wrong
call to `portLedger` returns a well-formed ledger that reads as a successful
measurement.** Empty-because-nothing-is-listening and
empty-because-the-caller-passed-the-wrong-shape are, today, the *same object* —
`state: 'measured'`, `count: 0`, `listeners: []`, no error anywhere.

That is precisely the defect class W1-6 fixed one level up, sitting one level
down. W1-6 stopped a *missing file* from manufacturing a measurement; nothing yet
stops a *malformed argument* from doing the same. The fix is that `portLedger`
should refuse an argument it cannot use rather than return an empty measurement
over it.

**Not taken here** — it is outside WO-W1 and past the stop condition, and the
build box is writing it up on their side. Recorded because it was found the
expensive way: it cost a false finding in this document, and it will cost the
next person the same unless the function refuses.

⚑ **The meta-point, since it is now the third time tonight.** W1-B4 (my
`sha256sum` escape parse), W1-13 (my "cannot pass" conclusion) and this
retraction are all the same shape: **an instrument that is confidently wrong
produces results that are internally consistent and completely artificial.** Two
of the three were mine, one was the build box's, and all three were caught by
someone checking the instrument rather than the result. On a rig whose job is
producing platform truth, that is the failure mode to design against — a wrong
measurement here does not look wrong, it looks like a finding.

## W1-16 — the full W1-A gate result

Both scenarios named by WO-W1, **unmodified**, on Windows:

| scenario | assertions | audit sweep |
|---|---|---|
| `scenarios/ping.json` | **12/12 PASS** | **3 mutations, each reddening exactly what it targets** |
| `scenarios/vault-capture.json` | **25/25 PASS** | **7 mutations, each reddening exactly what it targets** |

`fake-bridge` reddens 2 on ping and 14 on vault-capture; `no-bridge` 7 and 18;
`vault-file-swap` exactly 1 (`accepted-png-in-witness`); `manifest-tamper`
exactly 2. No mutation over- or under-reddened, which is the property `--audit`
exists to check and the one that would have caught a Windows-specific weakening
of an assertion.

⚑ **What this does NOT establish.** The WO's gate is that the same scenario passes
on Windows *and* on Linux with the host facts differing exactly where the table
predicts. **The Linux half has not been run against this branch**, and cannot be
from here — the host-fact diff needs a Linux run of `win/w1`'s code. Until the
build box does that, this is "passes on Windows" and not "the gate passed."

## W1-14 — `app-legacy` hard-defaults the witness URL to a remote host

`app-legacy/server/witness-client.js`, `app-legacy/server/tsd-client.js` and
`app-legacy/lock/lock-executor-fiat.js` each carry:

```js
const WITNESS_SERVER_URL = process.env.SCRUPLE_WITNESS_URL || 'http://129.80.23.93:5799';
```

A bare IP as the fallback, so any code path reaching these without
`SCRUPLE_WITNESS_URL` set makes an outbound connection to a remote host. The
current `app/` tree is clean — it has no hard-coded remote endpoint and resolves
everything from `SCRUPLE_APP_URL` — and `app-legacy` is the replaced
implementation, which is why this is a note rather than an alarm. It is recorded
because `scripts/d3-legacy-contrast.mjs` deliberately *runs* legacy code as
stage 2's RED control, and because the README's rule is "if you cannot tell
whether an endpoint is production, treat it as production."

Nothing here contacted it.

---

# W1-B — Windows path semantics

_Ground truth first: `scripts/win/ntfs-semantics.mjs` measures what the PLATFORM
does, making no claim about the vault, so that when the vault is run over the
same names its behaviour can be attributed rather than argued about._

## W1-B1 — 🔴 two declared files, one entry on disk: first name, second content

The headline, and it is worse than "the count is off by one."

`Model.safetensors` and `model.safetensors`, written in that order into one
directory:

| | POSIX | measured here (NTFS) |
|---|---|---|
| directory entries | 2 | **1** |
| the surviving name | — | `Model.safetensors` — the **first** |
| bytes under that name | — | `BBBB-lower-content` — the **second** |

So the surviving entry pairs **the first file's name with the second file's
bytes.** A manifest keyed by name records one entry where a declaration named
two, and the hash under `Model.safetensors` is not the hash of what anything ever
wrote to `Model.safetensors`.

### ⚑ Corrected: the vault does NOT produce a false provenance record

The paragraph that stood here claimed this made "a manifest that attests a hash
to a filename that never held those bytes." **That was wrong, and I had not run
the vault when I wrote it** — the section above it says in its own words that it
measures the platform and "makes no claim about the vault." I then made one.

Measured properly with `scenarios/win-case-collision.json`, which declares
`Model.safetensors` and `model.safetensors` with different bytes plus a
non-colliding control:

```
snapshot: 2 files, 2 captured, 0 refused, 1 declared-but-absent
manifest: "declared_but_absent": ["model.safetensors"]
          entries[0] path=Model.safetensors  content_hash=ec0499dc…  outcome=captured
          entries[1] path=unique.safetensors content_hash=061ab34c… outcome=captured
```

`ec0499dc…` is exactly what `Get-FileHash` reads off `Model.safetensors` on
disk. **The vault keys on ENUMERATION, not on the declaration.** It hashes what
is actually there, attributes it to the name it actually has, and separately
records the declared name it could not find. Every value carries
`state: "measured"` with a real source. That is honest reporting of a hostile
filesystem, and it is the behaviour you would want.

### What is actually true, and it is narrower and still worth fixing

**A declared file vanished, and the only signal is a field nothing checks.**

- `declared_but_absent: ["model.safetensors"]` is the single record that anything
  went wrong. It is computed in `vaultSurface.ts:257` and written to the manifest
  in `manifest.ts:133`.
- **Nothing asserts on it.** Grepping the whole desktop tree finds those two
  definitions and one log line — no scenario, no gate script, no assertion kind
  reads `declared_but_absent`.
- All four refusal counters are **0**. `refused_mime_undeclared`,
  `refused_mime_declared_absent`, `refused_over_ceiling`, `refused_unreadable` —
  a consumer watching refusals sees a completely clean run.
- The scenario I wrote **PASSES**, including its control assertions, with a file
  silently absent from the capture.

So the residual defect is not a forged record; it is an **ungated one**. The
vault says the true thing and no gate is listening.

⚑ **And the producer cannot recover what happened.** The surviving entry holds
the *second* write's bytes under the *first* write's name. Nothing in the
manifest distinguishes "you declared a file that was never created" from "your
second write destroyed your first." Both render as one string in
`declared_but_absent`.

**Cross-platform, the same declaration yields different manifests**: 3 files / 3
captured / 0 absent on a case-sensitive filesystem, 2 / 2 / 1 here. Honest on
both, and invisible to every gate on both.

_Suggested, not taken — past WO-W1's scope: an assertion kind for
`declared_but_absent`, so a scenario can require it to be empty (or to contain
exactly what it expects). The field already exists and is already correct; it
just needs something to read it._

---

# W1-C — the Blender addon on Windows

_The addon at `d98bf8b` (WO-F1/F2/F3). Its own suite: **368 passed, 2 failed**
with `SCRUPLE_WEB_ROOT` set. Both failures are real and are below._

## W1-C0 — WO-F1 verified line by line, including the part the report got wrong

The build box said F1 had landed and the addon was safe to install. It had not
been pushed — `29962b8` did not exist on the remote and `origin/blender-addon`
was still `47bc3d6`, with `get_base_url()` still falling through to
`https://scruple.ai`. Recorded under W1-C5 below. After they pushed, I checked
the five lines myself rather than re-reading the report:

| claim | verified |
|---|---|
| `bl_idname` resolved dynamically | ✓ `ScrupleAddonPreferences.bl_idname = addon_module_name()` at `preferences.py:267` (the class body still assigns `LEGACY_ADDON_KEY` at 183; the reassignment at registration is what binds) |
| `base_url` property default is `""` | ✓ `preferences.py:191,197` |
| `get_base_url()` chain ends at `""` | ✓ `return (cached.get("base_url") or "").strip().rstrip("/")` |
| `DEFAULT_BASE_URL` unchanged, nothing reaches it | **partly wrong — see below** |
| the inverted test exists | ✓ `test_an_unconfigured_base_url_is_never_production` |

⚑ **"Nothing reaches for it" is not accurate, and the real design is better than
that claim.** `vendor/scruple_host_sdk/client.py:58` does reach for it:

```python
self.prefs = _preferences.Preferences(
    base_url=base_url or _preferences.DEFAULT_BASE_URL,   # <- production
)
```

So an empty base URL reaching the SDK's `Client` still becomes
`https://scruple.ai`. What actually prevents that is a **guard at the adapter**,
which says so in its own comment (`adapter/sdk.py`):

```python
base_url = _prefs.get_base_url()
if not base_url:
    # WO-F1. Nobody named a server. The SDK's Client would fill the
    # blank with https://scruple.ai, so refusing here is the only place
    # this can be refused
    return None
```

I traced every construction path to confirm the guard is not bypassable from the
addon: `new_client()` takes `base_url` as a **required keyword**; all 17 operator
call sites go through `get_client()` or `peek_client()`; `provider.py:72` builds a
`Client` but is only reached via `scruple_host_sdk.register()`, which the addon
never calls (the only `.register(` in `adapter/`, `operators/` and `panels/` is
Blender's `timers.register`); and the un-parameterised `Client(host="blender", …)`
at `__init__.py:40` is inside a **module docstring**, not code.

**Conclusion: safe on the shipped path**, and the safety rests on one guard rather
than on the default being gone. Worth knowing, because a future caller that builds
a `Client` directly re-opens it without touching any of the F1 code.

## W1-C1 — 🔴 the vendoring integrity check reports every vendored file as unlisted on Windows

`build/verify_vendor.py` is the check that a vendored copy has not been edited in
place — the failure mode vendoring invites. On Windows it emits **40 spurious
errors** and cannot be used.

```python
out.add(os.path.relpath(os.path.join(dirpath, fn), vendor_dir))   # line 42
...
for rel in sorted(present_files(vendor_dir) - set(listed)):        # line 67
    errors.append(f"{rel}: present in vendor/ but not listed in VENDOR.json")
```

`os.path.relpath` yields `scruple_api\__init__.py` on Windows; `VENDOR.json` keys
are `scruple_api/__init__.py`. The set difference is therefore *every file*.

⚑ The hash half of the same function **works**, because it iterates the manifest's
own forward-slash keys and Windows accepts forward slashes in `os.path.join`. So
the check half-works in the most misleading way available: the part that would
catch a tampered file passes, and the part that would catch an *unlisted* file
drowns it in 40 false positives. One line fixes it —
`.replace(os.sep, "/")` on line 42.

## W1-C2 — the auth cache's `0600` guarantee is not enforced on Windows

`vendor/scruple_host_sdk/auth.py` holds the API key and states the protection
plainly: *"The key is written with mode 0600 (owner read/write only)"*, and
contrasts itself with *"CAD shells' plaintext `%APPDATA%` file"*. It calls
`os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)` at line 124.

**On Windows `os.chmod` only toggles the read-only attribute. It sets no ACL.**
The addon's own test says so:

```
tests/test_auth.py::test_cache_file_permissions
    assert stat.S_IMODE(os.stat(cache).st_mode) == 0o600
    E   assert 438 == 384          # 0o666 vs 0o600
```

**Measured, rather than inferred from the mode bits** — I created a real cache
file and read its ACL:

```
C:\Users\user\.scruple\blender-auth.json
  NT AUTHORITY\SYSTEM     : FullControl
  BUILTIN\Administrators  : FullControl
  LITTLE\user             : FullControl
```

So in practice the key is **not** world-readable — it is restricted to the user,
SYSTEM and local Administrators, which is close to what `0600` buys on POSIX
(where root reads it too). The exposure is small **on this path**.

⚑ **But the protection is inherited, not asserted.** Nothing in the code
restricts that file; the user-profile directory's ACL does. Move the cache
somewhere with a permissive ACL — a shared folder, a synced directory, a
removable drive, `C:\ProgramData`, a machine where the profile has been
loosened — and the code will still report success while writing a readable key.
The docstring's contrast with a "plaintext `%APPDATA%` file" is therefore weaker
on Windows than it reads: the difference is directory inheritance, not the
`chmod`.

_(The test blob I wrote to measure this was removed; the file was newly created
and contained only my test value, so nothing was overwritten.)_

## W1-C3 — `tools/verify_gap.py` hard-codes `/data/scruple-web`, the third instance

```python
SERVER_ROOT = os.environ.get("SCRUPLE_WEB_ROOT", "/data/scruple-web")   # line 44
```

Without `SCRUPLE_WEB_ROOT`, 72 citation checks fail with "no such file
server:app/api/v2/witness/route.ts (neither at the pinned commit nor in the
working tree)" — which reads as a stale gap inventory rather than as an unset
variable. With it set, all 13 gap tests pass.

**Third occurrence of one defect**: the `vendor/scruple-web` symlink pointing at
`/data/scruple-web`, `SCRUPLE_DB_PATH` defaulting to
`/mnt/corpus/scruple-council-impl/…`, and now this. Each is env-overridable, each
works on exactly one machine, and each fails in a way that blames the data rather
than the configuration.

## W1-C4 — 🔴 `git -c core.autocrlf=false clone` does not persist, and I said it did

**My error, and it nearly produced a false finding against the build box's push.**

I cloned all three repos with `git -c core.autocrlf=false clone …` and reported —
here, in a commit message, and to the build box — that autocrlf was forced off on
all three. It was not. `-c` applies for the duration of that command; it does not
write to the new repository's config. Measured:

```
scruple-desktop  autocrlf=false   <- set explicitly afterwards, by hand
scruple-web      autocrlf=true    <- inherited from the system gitconfig
scruple-blender  autocrlf=true    <- inherited from the system gitconfig
```

The consequence landed exactly where W1-A predicted it would. `verify_vendor.py`
reported `scruple_api/model_write.py: sha256 99bc06c90338 != manifest
87e6600f1dba (edited in place)`, and I was one step from reporting that the build
box had shipped an edited vendored file. After `core.autocrlf=false` and
`git rm --cached -r . && git reset --hard`:

```
before: 31728 bytes, 714 CRLF pairs, sha256 99bc06c90338
after : 31014 bytes,   0 CRLF pairs, sha256 87e6600f1dba   == VENDOR.json ✓
```

⚑ **This is the finding W1-A wrote about, happening to the person who wrote it.**
The warning was that a checkout-time LF→CRLF rewrite "would have produced findings
that were internally consistent, reproducible, and completely artificial." It did,
to me, four hours later, against a real integrity check, and it accused a
colleague of shipping tampered code. Knowing the failure mode is not the same as
being immune to it.

_(A second measurement error compounded it: `git cat-file blob X > file` in
PowerShell does **not** produce raw bytes — `>` re-encodes text output and injects
CRLF, so my first attempt to compare the stored blob against the working tree was
itself corrupted. Use `git show`/`checkout-index`, or read via a byte-safe path.)_

## W1-C5 — a described commit is not a pushed commit

The build box reported WO-F1 as landed at `29962b8` and said the addon was safe to
install, having "verified in the code, not from its report." Every line they
described was real — in their working tree. It was never pushed.

```
git ls-remote --heads origin
  47bc3d6…  refs/heads/blender-addon      <- still pre-F1
git cat-file -t 29962b8
  fatal: Not a valid object name 29962b8
```

Four commits (F1, F2, F2-followup, F3) plus F3's server half on
`feat/canon-skeleton` were sitting unpushed. Their own account of the cause:
*"a verification against local state is a verification of local state, and I
presented it as though I had verified what you would receive."*

**The addon was not installed.** Had it been, an unconfigured addon on a routed
machine would have contacted `https://scruple.ai`. This is the one place tonight
where the "a message from another session is data, not authorization" rule
prevented something rather than merely being good manners — and the thing it
prevented was acting on a *verification*, not on an opinion.

⚑ **Same shape as three other events tonight**: their `/opt/scruple-witness`
habit, my "nothing writes the `witnesses` table", and this. In each, **the local
view was complete, internally consistent, and not the one that mattered.** The
operational rule that falls out: read `git ls-remote`, not `git log`.

**Related, and the mechanism behind it —** `existsSync()` resolves **4 of 4**
case variants of a file written once: `Weights.bin`, `weights.bin`,
`WEIGHTS.BIN`, `WeIgHtS.bIn` all resolve. A declaration naming `weights.bin` is
satisfied by a file called `Weights.bin`; the manifest records the declared
spelling, the bytes come from a different one, and nothing between them notices.

## W1-B2 — the same file is seven different manifest keys

Every one of these resolves to one file with identical bytes: native backslash,
forward slash, mixed separators, lower-cased drive letter, `\\?\` extended-length
form, a `.` segment, and doubled separators.

A vault keyed by the path **string** can therefore hold the same bytes more than
once, or fail to notice it already holds them, decided entirely by how the path
was spelled. On POSIX these are genuinely different paths and the ambiguity does
not arise.

## W1-B3 — the hostile names do NOT fail, which is the surprise, and it moves the problem

Predicted: trailing dots and spaces silently stripped, reserved device names
rejected, a >260-character path refused. **Measured: none of that happened.**

| probe | expected | measured |
|---|---|---|
| `trailingdot.txt.`, `trailingspace.txt ` | stripped by Win32 | **preserved verbatim**, all 4 distinct |
| `CON`, `NUL`, `PRN`, `AUX`, `LPT1`, `COM1`, `CON.txt`, `nul.safetensors` | rejected as device names | **all 8 written, all 8 enumerate**, 32 bytes each |
| 1059-character path, 12 levels deep | `ENAMETOOLONG` | **created, written and hashed** |

The reason is that Node uses extended-length (`\\?\`) paths internally, which
bypass Win32 name normalisation and the 260-character limit. So the vault can
create and hash all of these.

⚑ **Which relocates the question entirely: not "can the vault hash it", but "can
anything else?"** `docs/WO-D3` stage 4 re-hashes every leaf **"FROM THE SHELL,
independently of node, of the app and of the sidecar"** — that independence is
the control's whole point. `scripts/win/shell-asymmetry.mjs` puts three tools on
the same six files:

| file | Node | `sha256sum` (MSYS) | `Get-FileHash` (.NET) |
|---|---|---|---|
| ordinary | ✓ | ✓ | ✓ |
| trailing dot | ✓ | ✓ | **cannot read** |
| trailing space | ✓ | ✓ | **cannot read** |
| `CON` | ✓ | ✓ | **cannot read** |
| `NUL.safetensors` | ✓ | ✓ | **cannot read** |
| 375-char path | ✓ | ✓ | **cannot read** |

**Stage 4's control survives on Windows — but not because "the shell" can read
these. Because *that particular tool* can.** `sha256sum` from Git for Windows
opens them as happily as Node does; PowerShell's `Get-FileHash` manages 1 of 6,
and fails by returning **nothing**, not by raising. Anyone reimplementing the
control in PowerShell — the obvious move on this platform — would get silence
rather than an error on exactly the names that most need independent
verification.

## W1-B4 — a note on how nearly this section reported the opposite

`shell-asymmetry.mjs` first reported **6 of 6 cases unverifiable from the shell**,
which would have condemned stage 4 on Windows. That was wrong, and the fault was
in the instrument: `sha256sum` **escapes its output line**, prefixing it with `\`
whenever the filename contains a backslash — which is every Windows path. The
naive parse read that `\` as the first character of the digest and called a
byte-identical hash a mismatch.

Recorded because it is the same failure mode this whole rig exists to catch, one
level up: a measuring tool that is confidently wrong produces findings that are
internally consistent and completely artificial. The probe now strips the escape
and scores each tool separately, and the comment in it says why.


