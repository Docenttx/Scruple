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

⚑ **Why this is a provenance defect and not a cosmetic one.** The vault's model
is "enumerate a directory, hash the set, treat it as a unit." On this filesystem
that unit can be silently smaller than what was declared, and one of its members
can carry a name that never belonged to its bytes. The count check
(`five-files-seen`) is the only thing standing between that and a clean pass —
and a count is exactly what a collision preserves when the declaration and the
directory are built from the same colliding pair.

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


