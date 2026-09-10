# Travel-laptop session report — 2026-09-10

_Windows rig, overnight. Branch `win/w1` off `desktop-studio`. Written to survive
a context compaction: everything needed to resume is here, including paths,
commands and the state of the running sandbox._

---

## 1. The rig, as built

| | |
|---|---|
| machine | Windows 11 Pro 10.0.26200, x64, i7-8650U (4C/8T), 16 GB, Intel UHD 620, real 1920x1080 |
| git | 2.55.0.windows.3 |
| node | **24.19.0** system · **20.20.2 portable** at `%TEMP%\node20\node-v20.20.2-win-x64` |
| python | 3.11.9 at `%LOCALAPPDATA%\Programs\Python\Python311` (takes precedence over the Store stub) |
| electron | 38.8.6 (chromium 140.0.7339.249) |
| blender | 4.2.16 LTS, `C:\Program Files\Blender Foundation\Blender 4.2\blender.exe` |
| sqlite3 | 3.53.4 (winget) |
| comfyui | source checkout `C:\SCRUPLEWORK\comfyui`, venv with **torch 2.14.0+cpu**, cuda=False |
| disk | ~114 GB free; total footprint ~2.7 GB, mostly the torch venv |

**Node 20 is required for anything touching the SDK.** `better-sqlite3`'s prebuild
is ABI-locked to the Node that installed it (115 vs Node 24's 137), and there is
no prebuild for Node 24 on win32 — it falls back to `node-gyp` and needs Visual
Studio C++ build tools. The desktop driver, the Next server and the witness all
run under the portable Node 20.

### Layout

```
C:\SCRUPLEWORK\
  scruple-web\        feat/canon-skeleton   (Next app + SDK + witness server source)
  scruple-desktop\    win/w1                (the Electron app + driver)  <- work branch
  scruple-blender\    blender-addon @d98bf8b
  comfyui\            upstream checkout + .venv
  .scratch\           scratch DBs, logs, blender profile
  scruple-desktop\vendor\scruple-web  -> JUNCTION to ..\..\scruple-web
```

### Standing the sandbox back up

```powershell
$n20 = "$env:TEMP\node20\node-v20.20.2-win-x64"

# witness (creates its own schema; dev secret = every leaf forgeable)
$env:PORT="5899"; $env:DB_PATH="C:\SCRUPLEWORK\.scratch\witness-scratch.db"
$env:SCRUPLE_WITNESS_ALLOW_DEV_SECRET="1"
Start-Process "$n20\node.exe" -ArgumentList "server.js" `
  -WorkingDirectory "C:\SCRUPLEWORK\scruple-web\services\witness-server" -WindowStyle Hidden

# Next app  (SCRUPLE_BDK_ALLOW_DEV is REQUIRED or it exits on first provisioning)
$env:SCRUPLE_DB_PATH="C:\SCRUPLEWORK\.scratch\scruple-scratch.db"
$env:SCRUPLE_WITNESS_DB="C:\SCRUPLEWORK\.scratch\witness-scratch.db"
$env:SCRUPLE_BDK_ALLOW_DEV="1"; $env:WITNESS_SERVER_URL="http://127.0.0.1:5899"
Start-Process "$n20\node.exe" -ArgumentList "node_modules\next\dist\bin\next","dev","-p","3902" `
  -WorkingDirectory "C:\SCRUPLEWORK\scruple-web" -WindowStyle Hidden
```

Driver runs additionally need `SCRUPLE_APP_URL=http://127.0.0.1:3902`,
`SCRUPLE_PYTHON=C:\SCRUPLEWORK\comfyui\.venv\Scripts\python.exe`, and for ComfyUI
work `SCRUPLE_COMFY_MAIN` / `SCRUPLE_COMFY_BASE`; `C:\Program Files\Git\bin` must
be on PATH for `bash`.

---

## 2. What runs, measured

| scenario | result |
|---|---|
| `ping.json` | **12/12**, unmodified, + audit sweep (3 mutations, each reddening exactly what it targets) |
| `vault-capture.json` | **25/25**, unmodified, + audit sweep (7 mutations, exact) |
| `comfy-generate.json` | **19/27** — the entire provenance claim green on real hardware |
| `blender-host.json` | Blender host materialises, ComfyUI launches, generation refused (§4.6) |
| addon suite (`pytest`) | **368 passed, 2 failed** — both failures are real Windows findings |

`ping` also passes on Linux against this branch, so that gate has both halves.

**`comfy-generate` is the headline.** A real ComfyUI, real torch, a genuine
1,700-parameter model actually loaded and run, on a box with a framebuffer and no
GPU. Green: `generation-went-through-the-gate`, `artifact-rehashes`,
`artifact-has-a-leaf`, `leaf-carries-a-fingerprints-hash`,
`fingerprints-hash-matches-its-manifest`, **`fingerprint-is-of-the-bytes`**. Six
of the eight failures are the port ledger reading `null` on Windows — which is
the change working, not breaking.

---

## 3. The findings

Full text in `docs/FINDINGS-WIN.md`. Ranked by consequence.

### 3.1 🔴 `file:$DB?mode=ro` silently opens the WRONG database (W1-10)

On Windows this does not error. SQLite does not treat `C:\...` as absolute after
`file:`; `?mode=ro` is never parsed — **a file literally named `=ro` is created in
the working directory**; and because `mode=ro` was never applied the open
*succeeds* against that empty new database. Every query returns nothing.

**A witness lookup for a leaf that WAS written comes back "not found."** In a
codebase whose whole claim is that leaves can be found and re-hashed, this is a
path bug wearing the costume of the provenance failure it imitates. Correct form
`file:///C:/…?mode=ro` opens the real DB *and* enforces read-only. Fixed at six
driver call sites via `sqliteUri()`; the nine `.sh` gates build the same string
and the build box is fixing those.

### 3.2 🔴 the capture gate's graceful shutdown never happens on Windows (W1-D1)

`ipc-comfy.js` stops the gate with `kill('SIGTERM')` and comments that SIGTERM is
chosen over SIGKILL because the handler drains the queue, and that killing it
*"would lose every enrichment record and any event store-and-forward was still
holding."* **Windows has no POSIX signals** — Node maps SIGTERM to
`TerminateProcess`. The handler never runs, so the platform takes precisely the
outcome the comment exists to prevent. Observed as
`outcome: "gate-wrote-no-result"`, `gateResult: null`.

Measured with a control (`scripts/win/sigterm-probe.mjs`): a child with no signal
**writes** its file; the SIGTERM child does not; SIGKILL does not either. Same
family as WO-F2 and strictly worse — F2 was a drain that dropped work, this is a
drain never invoked, and nothing announces the loss. Not fixed: the remedy is a
non-signal shutdown protocol, which is the gate owner's design call.

### 3.3 the vault under a case collision — honest, but ungated (W1-B1)

`Model.safetensors` + `model.safetensors` collapse to one NTFS entry holding the
**first name and the second file's bytes**. The vault handles this correctly — it
keys on **enumeration, not the declaration**, hashes what is there, and records
`declared_but_absent: ["model.safetensors"]`.

The defect is that **nothing reads that field**. It is computed at
`vaultSurface.ts:257`, written at `manifest.ts:133`, and those two lines plus a
log line are its only occurrences in the tree. All four refusal counters stay `0`,
so a consumer watching refusals sees a clean run — and my probe scenario passes
with a declared file silently missing. Not a forged record; an ungated one.

### 3.4 host facts now degrade honestly (W1-6)

`ports.js` and `namespace.ts` wrapped every `/proc` read in `catch { return [] }`,
so Windows produced `count: 0`, `allLoopback: false`, `enforcementPresent: false`
— **false measurements**, not degraded ones. `upstream.allLoopback: false` is the
exact shape of the finding the ledger exists to raise, manufactured from a missing
file; `enforcementPresent: false` is finding D4-1's entire substance, which would
have appeared to reproduce on a box that measured nothing.

Now: `state` (`measured`/`unavailable`/`refused`), `reasonCode`, `reason`, and
`null` — never `false`, never absent — for anything unmeasured. `unavailable`
(ENOENT, a platform fact) is kept distinct from `refused` (EACCES, a fact about
this run). Controls in `scripts/win/host-facts-control.mjs` demonstrate all three
states in one run and show RED against the **real previous implementation**.

### 3.5 Windows path and text semantics

- **`tsx.sh` could not run at all.** MSYS rewrites POSIX argv for native
  `node.exe`, so `--import /c/…` arrived as `C:/…` and Node rejected it as
  protocol `'c:'`; env vars are *not* rewritten and needed `cygpath -m`. Fixed,
  guarded on `command -v cygpath`.
- **CRLF ate a Blender report.** `desktop-run.mjs` matched
  `/<<<E4_BLENDER\n…/`; Blender writes CRLF on Windows, so the report was printed,
  discarded, and reported as *"Blender produced no report"*. Fixed to `\r?\n`.
- **`python3` is a Store alias stub** that exits 9009 telling you to install
  Python — on a machine where 3.11.9 works. Fixed via `pythonBin()`, which accepts
  a candidate only if it prints a version.
- **PowerShell 5.1 `Out-File -Encoding utf8` writes a BOM** and `JSON.parse`
  rejects it.
- **`Get-FileHash` reads 1 of 6 hostile filenames** (trailing dot/space, `CON`,
  `NUL.safetensors`, 375-char path) and fails by returning **nothing**. MSYS
  `sha256sum` reads all six — so WO-D3 stage 4's "independently of node" survives
  because of *that tool*, not because of "the shell".
- **Captures are physical pixels**: a 1000x700 window with content 988x645
  captures at 1275x833 (`scaleFactor` 1.29). Two Windows APIs describe the same
  monitor 29% apart. Never assert on screenshot dimensions.

### 3.6 the addon on Windows

- **WO-F1 verified line by line on a real manifest install** — not in a mock.
  `bl_ext.user_default.scruple_blender`, `preferences_object_bound: True`,
  `get_base_url()` → `''`, `is_configured: False`. E7-2 is genuinely fixed.
  ⚑ Their report's one wrong claim: `client.py:58` **does** still reach for
  `DEFAULT_BASE_URL`. What prevents production is a **guard in `adapter/sdk.py`**
  that refuses to build a client with an empty base URL. Safe on the shipped path,
  resting on one guard rather than on the default being gone.
- **`build/build_addon.sh` cannot run on Windows** — needs `rsync` and `zip`,
  neither present, and calls `python3`. Replaced by
  `scripts/win/build-addon-zip.ps1`, which reproduces its staging exactly.
  ⚑ Both `Compress-Archive` and .NET `ZipFile.CreateFromDirectory` write
  **backslash** entry names on Windows — out of ZIP spec, and Blender reads such
  an archive as flat mis-named files. Entries are now written by hand and the
  script *verifies* the archive before it is used.
- **`verify_vendor.py` reports all 40 vendored files as unlisted** — it compares
  `os.path.relpath` output (backslashes) against forward-slash JSON keys. The hash
  half works, so the check half-works in the most misleading way available.
- **The auth cache's `0600` guarantee is not enforced.** `os.chmod` sets no ACL on
  Windows. Measured the real ACL: SYSTEM / Administrators / user — adequate here,
  but **inherited from the profile directory, not asserted by the code**.

### 3.7 machine-specific absolute paths — four instances

`vendor/scruple-web` committed as a symlink to `/data/scruple-web`;
`SCRUPLE_DB_PATH` defaulting to `/mnt/corpus/…`; `E4_ZIP` defaulting to
`/data/scruple-blender/dist/…`; `verify_gap.py`'s `SERVER_ROOT` defaulting to
`/data/scruple-web`. Each is env-overridable, each works on exactly one machine,
each fails in a way that blames the data rather than the configuration.

### 3.8 the witness binds `0.0.0.0` (W1-15)

`server.js:1564`, while sealing with the forgeable dev secret. The CVM surrogate
on the same box correctly binds loopback. Measured on this rig: **two ALLOW
inbound rules for node.exe** — there is no firewall mitigation. Moot on an
isolated machine; the build box has it as WO-F8, with the good fix being that
`SCRUPLE_WITNESS_ALLOW_DEV_SECRET` should *force* loopback rather than a `BIND`
variable that can be set wrongly.

### 3.9 ComfyUI now requires a UUID prompt_id — bears on G7

`blender-host` reached ComfyUI and was refused:

```
400  invalid_prompt_id — "prompt_id must be a UUID string in canonical
     lowercase hyphenated form; omit it to let the server generate one"
```

The Level-2 design has the **host announce its own prompt id** and the gate
correlate on it. That correlation key is what G7 ("witness every object ported
ComfyUI → Blender") depends on. **The ComfyUI commit was not pinned before work
stopped** — the behaviour is observed, the version boundary is not established.

---

## 4. Things I got wrong, and corrected

Recorded because the pattern is the most useful output of the night.

1. **`git -c core.autocrlf=false clone` does not persist.** I reported all three
   clones were forced off; two were `autocrlf=true`. `verify_vendor` then reported
   a vendored file "edited in place" and I was one step from accusing the build
   box of shipping tampered code. After forcing it off and re-materialising, the
   hash matched byte for byte. **The trap documented at midnight caught its author
   at four.**
2. **"`vault-capture` cannot pass on any machine with only these three repos"** —
   filed as a finding, and false. I grepped `SCRUPLE_WITNESS_DB` (readers only;
   the server writes `DB_PATH`), read a deployment header as a prohibition, and
   missed that `npm install` in that directory is an undocumented step. Withdrawn,
   with the wrong reasoning kept. **Filing a *cannot* deserves the same evidence
   as filing a defect.**
3. **"The vault attests a hash to a filename that never held those bytes"** — told
   to the build box, who called it the most serious find of the night. I had not
   run the vault. Retracted before they spent a work order on it.
4. **"6 of 6 unverifiable from the shell"** — `sha256sum` escapes its output with
   a leading `\` for any filename containing one. My parser ate it as part of the
   digest. Would have condemned WO-D3 stage 4 on Windows.
5. **"Two Block firewall rules"** — they are **Allow**. Came from piping
   `Get-NetFirewallApplicationFilter` into `Get-NetFirewallRule`, which
   mis-associates. A mitigation that does not exist is worse than a known
   exposure, because it stops anyone looking again.
6. **`git cat-file blob X > file` in PowerShell** does not produce raw bytes — `>`
   re-encodes and injects CRLF, corrupting the very comparison it was made for.

⚑ **The shape, six times:** an instrument that is confidently wrong produces
results that are internally consistent and completely artificial. Twice the wrong
answer was the more dramatic one. On a rig whose job is platform truth, a bad
measurement does not look like an error — **it looks like a finding.**

A seventh, theirs, is the one that mattered most: WO-F1 was reported as landed and
verified, and had never been pushed — `29962b8` did not exist on the remote. Had I
installed on their say-so, an unconfigured addon on a routed machine would have
contacted production. **Read `git ls-remote`, not `git log`.**

---

## 5. Branch state

`win/w1`, pushed. Latest commits:

```
9209dec  W1-D: a real generation on real hardware, and the gate's drain that never runs
de54925  W1-C: the addon on Windows, and the autocrlf trap catching its own author
91dbc3c  Correct W1-B1: the vault is honest; the defect is that nothing gates it
a1dc424  W1-17: both halves of the host-fact diff, and the distinction it restored
89c1021  vault-capture passes 25/25 on Windows; W1-13 withdrawn because I was wrong
```

Tools added under `scripts/win/`: `blank-detector.mjs` (+ 5 controls),
`score-capture.mjs`, `capture-desktop.ps1`, `fb-probe-main.cjs`,
`geometry-probe.cjs`, `window-lifecycle-probe.cjs`, `host-facts-control.mjs`,
`ntfs-semantics.mjs`, `shell-asymmetry.mjs`, `sigterm-probe.mjs`,
`build-addon-zip.ps1`, `addon-binding-probe.py`. Scenario:
`scenarios/win-case-collision.json`.

---

## 6. Where things stand

**The app tested so far is not the product.** WO-D5 replaced the Electron shell
with a bare window on a served `/studio` diagnostics page — no tab bar, no
webviews, no project sidebar. The build box signed it off having verified the
stylesheets were byte-identical and reported "the canon design came across": true
of the CSS, false of the interface. The founder caught it by looking at the app
running on this laptop.

This invalidates little of the work above — none of it tested the UI; it all sits
underneath the shell. The exception is that the framebuffer screenshots are of the
D5 page, so they prove the framebuffer is live (what they were for) but are not
pictures of the product.

**The G series** (`docs/WORK-ORDERS-G.md`, `desktop-studio` @ `f7dc6b8`; read
`docs/G-SERIES-REPORT.md` first): G1 legacy app on Electron 38, G2 C2PA + EU
watermarking, **G3 this rig tests it**, G4 Blender tab, G5 new plugin, G6
hand-edited `.blend`, G7 witness objects ported ComfyUI → Blender.

**G3's gate**: a person completes pick-a-project → work in a tab → checkpoint →
lock → see the root, on Windows, **without reading source**. Every point where I
have to ask what something means is a finding; user friction is the deliverable;
reading source to understand a control *fails* the gate. Tab set must be exactly
ComfyUI · Kohya_ss · Workspace · Wallet(fiat) · Wallet(blockchain), and a tab
whose app is not running is **absent, not empty**.

G1 and G2 are not done. Nothing to install or test yet, and the current
`desktop-studio` head is still the D5 shell.

**Rails, unchanged**: never modify `/opt/scruple-witness`; never contact
`127.0.0.1:5799` or `:3001`; the CVM surrogate on 8799 is software-backed, so a
leaf it signs is `passthrough` or `stale`, never `verified`; do not flip
`CHECKPOINT_VECTORS_SETTLED`. Nothing produced on this rig is evidence of anything
beyond "the code path works" — the witness seals with a deliberately forgeable
dev secret.
