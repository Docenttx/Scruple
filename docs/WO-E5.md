# WO-E5 — the Blender region, drawn from capabilities and absent when there is no Blender

_2026-09-09. Desktop repo + server repo (`/data/scruple-web`); the addon repo is
untouched. Gate: `bash scripts/e5-gate.sh` (`npm run e5`); whole transcript in
`.run/e5/gate-final.txt`._

## Verdict

**GATE PASSED**, with two things said plainly rather than smuggled into the
table: one part of it is proved by a control of our own rather than by a product
(finding **E5-2**), and the recorded gate run **exits 1 on exactly one check**,
for a reason worth keeping.

⚑ **The gate caught its own documentation.** Stage 1 greps `app/ipc-profile.js`
for the sentence this work order retires — `not installed in this app yet` — and
requires zero occurrences. The first full run went **RED** there, at one
occurrence, because the comment I had written explaining the change *quoted the
sentence it was retiring*. The behaviour was correct and the control was
matching prose. The comment was reworded and the check was **widened** (`grep -r`
over all of `app/`, not one file) rather than narrowed.

⚑ **And the first transcript recorded a second failure that was mine, not the
code's.** Making that one-line fix, I edited `scripts/e5-gate.sh` *while the
gate was running*. `bash` reads a script by byte offset as it executes, so the
edit shifted the remainder underneath the running shell: control B and control C
were re-executed, both audit sweeps ran a second time (identically clean), and
one re-entry landed mid-line and exited `127`. The first run is kept, unedited,
as `.run/e5/gate-run1-selfcorrupted.txt`, and the gate was re-run from start to
finish with nothing touched: `.run/e5/gate-final.txt`:

```
════ WO-E5 GATE PASSED ════        34 shell checks ok / 0 FAIL · 39 scenario assertions PASS
```

— ten stages, both audit sweeps, and the shell re-measurement, with the bridge
address landing on `http://127.0.0.1:36895` that time: a third run, a third
port, and the same agreement between what the app said, what the shell sees in
the Blender profile, and what the kernel gave the gate. Both transcripts are in the repo's `.run/`
(gitignored), and this paragraph is here because a transcript with an
unexplained `127` in it is worse than no transcript.

**Every check the first run performed was green except that one**, and the
checks that ran twice because of the corruption produced identical results both
times — including both audit sweeps, which is more evidence than one clean run
would have given.

| what the work order asked for | outcome |
|---|---|
| the region renders from `GET /api/v2/capabilities` | **PASS** — `blender` is a region id in `lib/v2/deployment.ts`, `applicableRegions()` filters it, and `/studio` fetches the endpoint over HTTP as WO-D5 built it |
| the canon design carries across unrestyled | **PASS** — the region's heading computes `letter-spacing: 1px` in the real window, the canon's ALL-CAPS section header, measured by the layout engine |
| what is on the box comes from the preload bridge in three states — measured, unavailable, refused — never a plausible default | **PASS** — `scruple:blender`, and every reading inside it carries its own state as well |
| **gate:** with Blender installed the region names the version read from the running binary | **PASS** — `4.2.23`, from `blender --version`, cross-checked against the driver's own reading and re-taken from the shell |
| …the addon's enabled state | **PASS** — `bl_ext.user_default.scruple_blender`, read out of a running Blender's own `preferences.addons` |
| …and whether a bridge is pointed at the gate | **PASS**, ⚑ **with a stub bridge** — the comparison is real and neither side of it was invented here, but the addon holding the address is ours. See E5-2. |
| **control:** with Blender not installed the region is **ABSENT** — `count === 0` *and* zero occurrences in the serialised document | **PASS** — `scenarios/blender-absent.json`, both halves, plus an inverse control that makes them red |
| `STATE.md` says Blender is not installed in this app yet — that sentence changes or it does not | **CHANGED.** `app/ipc-profile.js` no longer contains the string; `docs/STATE.md` §0 carries a dated amendment saying exactly which part is retired and which part is still true |

The region, read out of the run's own result file:

```
binary   /mnt/corpus/scruple-desktop/vendor/blender/bin/blender (configured)
version  4.2.23
addon    enabled — bl_ext.user_default.scruple_blender
bridge   pointed at the gate — http://127.0.0.1:43229
```

…and `43229` is a port the kernel allocated to the gate seventy seconds earlier.
Nothing in this repository could have written that string in advance, which is
the point of the last line.

---

## The design question this work order had to answer first

Every region WO-D5 built applies because of what the **deployment** is, and
`lib/v2/deployment.ts` says so in as many words: *"The server knows the SHAPE of
a deployment. It does not know whether ComfyUI is installed on someone's
laptop."*

The Blender region breaks that, and it has to: the work order requires it to be
**absent when Blender is not installed**, and installation is a fact about a
machine. There were three ways to go and only one of them is consistent with the
rest of the estate:

1. **The server probes.** Impossible — it is a different box, and if it were the
   same box it would still be guessing about the user's.
2. **The client hides it.** The dashboard draws the region always and
   `HostFacts` returns nothing, so the region renders empty or hidden. This is
   exactly the failure WO-D5 exists to prevent — *"a region that does not apply
   is not rendered — no node, no heading, no placeholder"* — and it would put
   applicability back inside a renderer a lying preload can reach.
3. ⚑ **The host announces, the server decides.** Which is what
   `x-scruple-profile` already does one level up, and what this work order
   extends: `x-scruple-host-apps: comfyui,blender`, set on the window's session
   in the main process, built from `fs.existsSync` at the moment the header is
   made.

So there are now two announcements and they answer different questions — *which
deployment is asking* and *what that machine has* — and the server records both,
including when it did not use one.

### Three answers where a boolean would have given two

`applies` is one boolean; `reason` is three sentences, and the split is the same
one `HOST-HOOK.md` holds open between `blind` and `declined`:

| the host said | region | why it matters |
|---|---|---|
| `comfyui,blender` | **drawn** | the host will fill it |
| `comfyui` | absent | the host looked and there is no Blender on that box |
| nothing at all | absent | **nothing has measured this machine** — a different fact, with a different fix |

Collapsing the last two would tell an operator "you have no Blender" when the
truth is "your host never said". The gate checks that the two `reason` strings
differ, and `announce-without-blender` and `announce-nothing` are separate
mutations for the same reason.

### And the app is still listed

`docs/STATE.md` §0: *"a dashboard that quietly omitted them would be the failure
mode."* Still binding. `compute` keeps its Blender entry in every case, marked
unavailable, with the reason — what appears and disappears with the machine is
the **panel of readings nobody took**. Both scenarios assert this: the region
has zero occurrences and `data-compute="blender"` has one.

---

## What was built

### Desktop

| file | what |
|---|---|
| `app/ipc-blender.js` | `scruple:blender`. Where Blender is looked for, the version out of the binary, the addon out of a running Blender, and the bridge comparison. `installedAppIds()` — what the announcement header is built from. |
| `scripts/e5-blender-probe.py` | runs inside Blender. Enables nothing, installs nothing, writes nothing; reports the addon module and every enabled addon that keeps an address in its own preferences. |
| `app/main-modular.js` | the `x-scruple-host-apps` announcement, and `shutdownBlender()` wired into every exit path |
| `app/preload.js` | `blender()` — a channel of its own |
| `app/ipc-profile.js` | the Blender app entry is a measurement now, from the same `resolveBinary()` the header uses, so the app list and the announcement cannot drift |
| `scripts/e5-stub-bridge/` | ⚑ a CONTROL, not a product. See E5-2. |
| `scenarios/blender-region.json` | 20 assertions, 7 mutations |
| `scenarios/blender-absent.json` | 14 assertions, 3 mutations |
| `scripts/desktop-run.mjs` | the `blender-install` fixture kind and seven new mutations |
| `scripts/e5-gate.sh` | the gate and its controls (`npm run e5`) |

### Server (`/data/scruple-web`)

| file | what |
|---|---|
| `lib/v2/deployment.ts` | the `blender` region, `HOST_APP_IDS`, and the announcement on the answer as `host_apps: { announced, honoured, reason }` |
| `app/api/v2/capabilities/route.ts` | `&host_apps=` and `x-scruple-host-apps`, validated — an unknown id is **refused**, never dropped |
| `app/studio/page.tsx` | forwards the announcement verbatim; it does not parse it |
| `components/studio/regions.tsx` | the region. No "not detected" branch exists, because `applicableRegions()` never returns it. |
| `components/studio/HostFacts.tsx` | a per-fact channel map, the blender rows, and the re-ask described in E5-4 |
| `test/v2/deployment-shape.test.ts` | +7 tests |

⚑ **The gate was not touched.** `docs/BLENDER.md`: *"if a WO here needs a change
to the gate, that is a finding to report, not a licence."* Checked rather than
asserted — since WO-E4's commits (`ecb8d96` / `634c66e`):

```
$ git diff --name-only ecb8d96 -- app/comfy | wc -l                       → 0
$ git -C /data/scruple-web diff --name-only 634c66e       -- lib/capture lib/db/migrations packages | wc -l                   → 0
$ git -C /data/scruple-web diff --name-only 634c66e
      app/api/v2/capabilities/route.ts   app/studio/page.tsx
      components/studio/HostFacts.tsx    components/studio/regions.tsx
      lib/v2/deployment.ts               test/v2/deployment-shape.test.ts
```

Six files, all of them the dashboard and the endpoint it reads. No migration, no
leaf field, no MAC, and the addon repo has no commit from this work order at
all.

---

## The gate

### Three readings, and how each one is kept from being a constant

| reading | where it comes from | the control that moves it |
|---|---|---|
| version | `blender --version` on the binary the app resolved | `blender-vanishes` — no binary, `state: "unread"` with a reason, never a number |
| addon | `bpy.context.preferences.addons` in a headless 4.2.23 | `no-addon-profile` — same binary, same version, a profile with nothing in it, and only the addon assertions move |
| bridge | an address in a bridge addon's own preferences vs the gate's allocated port | `bridge-elsewhere` — the bridge stays installed and configured and stops pointing at the gate; the state must become `elsewhere`, not `none` |

### Stage 5 — the same three, re-taken from the shell

Outside node, outside the app, outside the driver: this repo's Blender, the same
profile, the probe run from bash, compared against what the app reported. If the
app had invented any of the three the two columns would disagree.

```
                          THE APP SAID                          THE SHELL SEES
version                   4.2.23                                4.2.23
addon module              bl_ext.user_default.scruple_blender   bl_ext.user_default.scruple_blender
bridge address            http://127.0.0.1:44219                http://127.0.0.1:44219
the gate's own port       http://127.0.0.1:44219                (allocated by the kernel)
```

⚑ The port is `44219` here and was `43229` in the run quoted at the top of this
report. It is not a constant; it is whatever the kernel handed the gate that
minute, and the address inside a Blender addon's preferences is the same string
because a third party put it there after reading the gate's own ready file.

### ⚑ The control the work order names

`scenarios/blender-absent.json` asserts the absence **positively**, on a machine
where every place the app looks has been pointed at an empty directory — not a
flag that hides a panel:

```
⚑-the-region-has-no-node                 count === 0
⚑-the-region-is-not-even-mentioned       0 occurrences of data-region="blender"
⚑-no-host-facts-panel-was-drawn-for-it   0 occurrences of data-host-fact="blender"
the-app-is-STILL-listed…                 1 occurrence  of data-compute="blender"
```

and `blender-arrives` puts a real Blender back, which turns all of them red. An
absence assertion that cannot be made to fail is a constant with a comment on
it.

### The sweeps

Every mutation reddened **exactly** its declared list and nothing else. What
separates them is the design working rather than the tests passing.

```
  blender-absent
    blender-arrives                       caught   7 red exactly
    announce-a-blender-that-is-not-there  caught   3 red exactly
    assert-expectation                    caught   1 red exactly

  blender-region
    announce-without-blender              caught   6 red exactly
    announce-nothing                      caught   6 red exactly
    blender-vanishes                      caught  13 red exactly
    no-addon-profile                      caught   6 red exactly
    bridge-elsewhere                      caught   3 red exactly
    fake-bridge                           caught  13 red exactly
    assert-expectation                    caught   1 red exactly
```

Read the differences, not the numbers:

- **`announce-without-blender` and `announce-nothing` land on the same six**,
  by two different routes. One says the box has no Blender; the other says
  nothing at all. That both remove the region is the claim; that the
  capabilities answer gives two different reasons is checked separately, in the
  gate's stage 2, because a UI cannot show the difference and an operator needs
  it.
- **`blender-vanishes` reddens thirteen and `announce-without-blender` six.**
  The seven extra are the *readings*: with the announcement lied about, the box
  still has a Blender and `scruple:blender` still measures it correctly — only
  the region is gone. That difference is the boundary between what the server
  is told and what the host measures, expressed as two mutation sets.
- **`no-addon-profile` reddens six and `bridge-elsewhere` three**, with the
  bridge three inside the addon six. Not a coupling bug: a profile with no addon
  installed has no stub bridge in it either, so `bridge` correctly falls to
  `none`. Same binary, same version — the version assertions stay green under
  both, which is what makes them separate readings rather than one.
- ⚑ **`fake-bridge` is the honest measure of what a DOM assertion is worth.**
  `the-region-is-drawn` stays **GREEN**: the region's applicability comes from a
  header the main process sets on the window's session, and a preload that
  answers in the renderer cannot touch it. Every reading inside goes red,
  because a renderer-local stub cannot start a Blender. Same shape as WO-D5's
  finding about the model root and WO-D4's about the port ledger: a claim is
  worth what the unfakeable part of it is worth.

---

## Findings

### ⚑ E5-1 — the announcement is trusted for the SHAPE, and it is not a measurement

A host that announces a Blender it does not have gets its region drawn. Measured
rather than argued — `scenarios/blender-absent.json`'s second mutation, on a box
where every place the app looks is empty:

```
region nodes: 1
panel:  binary   none found
        version  unread — no executable at …/no-blender-here/blender and none
                 named "blender" on the search path
        addon    unread — (the same reason)
```

So the frame is the announcement's and every value in it is a reading. That is
the honest limit of a host-announced region and it cannot be engineered away
from the server side: the alternative is the client dropping the region when the
readings come back empty, which puts applicability back inside a renderer — the
exact thing WO-D5's `fake-bridge` control exists to catch.

What it costs is bounded and worth stating: a lying host can make a **panel of
"unread" appear**. It cannot make a version, an addon or a bridge appear,
because those are not in the announcement.

### ⚑ E5-2 — `at-the-gate` is proved with a stub bridge of ours, not one of the eleven

The comparison is real and neither side of it was invented here: an address read
out of an addon's own `AddonPreferences` inside a running Blender, against a
port the kernel allocated to the gate at launch (`listenPort: 0` — the gate
"reports back" and nothing guesses it). The driver writes that address into the
bridge's config only after reading it out of the gate's **own ready file**, and
if that never happens the state stays `elsewhere` and the assertion **fails**
rather than passing vacuously.

But the addon holding the address is `scripts/e5-stub-bridge`, written for this
work order. It is not ComfyUI-BlenderAI-node, not ComfyUI-Blender, not any of
the eleven in `docs/canon/blender-l2/09-BLENDER-COMFYUI-RUNTIME.md`; it does not
generate; and its own docstring says so. **No real bridge was installed or
exercised in this work order.** That is WO-E6's job, and the work order says so
— *"a bridge inside Blender is pointed at the gate instead of at ComfyUI"*.

What E5 does establish is that the three states are reachable and distinguished
on real Blender profiles: `none` (nothing installed), `elsewhere` (installed,
:8188), `at-the-gate` (installed, and the address is the gate's).

### E5-3 — bridge detection is by SHAPE, so it will over- and under-report

There are eleven bridges and we fork none of them, so a name list would answer
"no bridge" for the twelfth. The probe therefore looks for an enabled addon with
a **string preference named like an address holding a value shaped like one**
(`(url|addr|address|endpoint|server|host|ip)$`, value matching a host/URL
pattern). Two consequences, named rather than hidden:

- **Over-reporting.** An addon that keeps an unrelated URL in a property called
  `server_url` is reported as a bridge candidate. It would then read
  `elsewhere`, which is wrong about that addon and harmless about the gate.
- **Under-reporting.** A bridge that keeps its address in a JSON file rather
  than in `AddonPreferences` is invisible to this, and reads `none`. Several of
  the eleven may; none was checked, because none was installed.

Every candidate is reported in `bridge.candidates`; `bridge.address` is the
first. A deployment with two bridges pointed at two places is representable in
the reply and is flattened in the panel.

### E5-4 — the reading is dated by the gate it was taken against

Found while building, and worth recording because the obvious implementation
passes the scenario by accident. The Blender panel mounts when the page loads,
which on a desktop is **before** the user launches ComfyUI. A probe taken then
compares a bridge's address against nothing, and `unknown` — *"there is no gate
running to compare against"* — is the only true answer.

Caching that for the session would leave the dashboard showing a not-yet-answer
for the rest of the session. So the probe cache key is
`binary | profile | gateUrl`, and `HostFacts` re-asks (only) while the state is
`unknown`. Two Blender launches per session in the worst case, and the second
one is what produced the `at-the-gate` reading in the gate above.

### E5-5 — every dashboard render on a box with Blender starts a headless Blender

The cost of putting the measurement where the measurement is. `blender --version`
plus one `--background --python` probe, ~14s each under `qemu-user` on this
aarch64 box (finding E3-2); on a machine with a native build it is closer to a
second. Shared across the four panels and across re-renders, re-taken only when
the gate changes, and killed in every exit path (`shutdownBlender()`, plus
`will-quit`). It is a real cost and it is chosen: the alternative is a version
number from somewhere other than the binary.

### E5-6 — `/usr/bin/blender` 3.0.1 is findable and is deliberately not what this app uses

The lookup order is `SCRUPLE_BLENDER_BIN` → the app's own vendored tree →
`SCRUPLE_BLENDER_SEARCH_PATH` (default `$PATH`). On this box the vendored 4.2.23
wins, which is right: the addon's manifest floors at 4.2.0. On a user's box with
only a 3.x on `PATH`, this region will report **`3.0.1` and "addon not
enabled"** — both true, and the useful pair, because WO-E3 measured that a 3.x
Blender loads the shipped zip through the legacy `bl_info` path where the
declared minimum is enforced by nothing (finding **E3-1**, still open). The
region will say the addon is not enabled; it will not say *why that Blender is
too old*.

---

## What this does NOT cover

- **No bridge from the eleven was installed, configured or run.** E5-2.
- **Nothing was launched.** This app still does not start Blender for a user;
  it starts one to *ask it questions* and kills it. There is no launcher, no
  render, and no leaf in this repository produced by one. WO-E6.
- **No leaf was written by this work order.** The region is a UI over readings;
  it puts nothing on a leaf, touches no MAC, and changed nothing under
  `app/comfy/` or `lib/capture/`. `git diff` over both is empty.
- **The `at-the-gate` reading says nothing about whether a generation happened.**
  A bridge pointed at the gate is a configuration, not an event. What a
  generation through it produces is WO-E6's gate.
- **No pixel was read.** The design claim is `getComputedStyle`'s answer for the
  region's heading, in the real window, after the cascade. `docs/DESIGN.md`:
  llvmpipe returns a blank frame here, verified three ways.
- **Every Blender measurement is on an emulated CPU** (E3-2). Reading a version
  string and enumerating preferences are CPU-agnostic; that sentence stops being
  free the moment E6 renders anything.
- **The announcement is not authenticated.** Nothing signs `x-scruple-host-apps`
  and nothing needs to yet — it decides which panel is drawn and nothing else.
  It would need saying again the day it decides anything on a leaf.

---

## Regressions

WO-D5 built the dashboard this region was added to, and WO-D4's generation runs
in the same window that now starts a Blender when the page loads. Both were
re-run rather than reasoned about:

| suite | result |
|---|---|
| `scenarios/dashboard-shape.json` — WO-D5's dashboard, with a region added to it | **PASSED** |
| `scenarios/comfy-generate.json` — WO-D4's generation, in a window that now starts a Blender | **PASSED** |
| `test/v2/deployment-shape.test.ts` (18, 7 new) + `test/v2/canon-theme.test.ts` | **27 pass, 0 fail** |

⚑ **WO-D5's audit sweep was NOT re-run** — it is ~40 minutes on its own and it
did not fit in this work order's time. Its five mutations are the ones a new
region could in principle disturb, and they were not re-checked; only the clean
run above was. `bash scripts/d5-gate.sh` is the command that would, and it is
the honest next thing for whoever runs the D-chain nightly.

The same applies to `npm run gate` as a whole (D1…D7): not re-run here. What was
re-run is the two scenarios above, chosen because they are the two the change
touches — the dashboard it adds a region to, and the heaviest run in the repo,
which now carries a headless Blender launch alongside a ComfyUI launch and a
generation (finding E5-5).

## How to re-run

```bash
cd /mnt/corpus/scruple-desktop
npm run e5              # the whole gate, ~25 min (it launches Blender ~20 times)
npm run e5:scenario     # the region, on its own
npm run e5:absent       # the control, on its own
```

`npm run e5` needs the scratch app on `:3902`, `vendor/blender/bin/blender`
(`npm run e3:install`) and the addon zip in `/data/scruple-blender/dist/`. It is
not in `npm run gate` for the reason WO-E4's is not: the D-chain is already ~25
minutes and this adds ~25 more of `qemu-user` Blender launches. That is a
runtime argument, not a confidence one.
