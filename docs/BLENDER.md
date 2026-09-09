# Blender in Desktop Studio — design intent

_2026-09-09, written before the E-series. Read `DESIGN.md` and `HOST-HOOK.md`
first; this does not reopen either._

## The claim we are trying to earn

A Blender user generates an image with a ComfyUI bridge and gets **one leaf that
says both things at once**: these bytes came out of that graph with those model
weights (WO-D4), and they were the viewport of scene X at frame Y through camera
Z (WO-D6 Level 2). Neither half is worth much alone. The gate observes a wire
and cannot know what a camera is; the addon knows what a camera is and never
sees the weights.

Today those halves live in two products that do not know about each other:

| | `/data/scruple-blender` | Desktop Studio |
|---|---|---|
| talks to | the server, directly | the gate, which talks to the server |
| sees the ComfyUI graph | **no** | yes |
| sees the model bytes | **no** | yes |
| knows the scene | **yes** | no |
| `host_semantics` on its leaves | n/a — not a component leaf | `blind` alone; **`supplied`** with the addon (WO-E4) |

The E-series makes the addon the **Level-2 adapter** for the gate, so the two
halves land on one leaf. **WO-E4 landed that**: `adapter/host_hook.py` in the
addon repo declares itself through the SDK's own `register_host()` when the
addon is enabled, `bpy.ops.scruple.host_announce` writes one document per
generation from `bpy` datablocks, and `scenarios/blender-host.json` reads them
back off a leaf beside `model_fingerprints`. Measured, not designed:
`scripts/e4-gate.sh`, and `docs/WO-E4.md` for what it does not cover.

## What is NOT changing

- **The gate never changes.** `HOST-HOOK.md` is the contract, and Blender is
  consumer #1 of it, not a special case in it. If a WO here needs a change to
  the gate, that is a finding to report, not a licence.
- **Registration stays static and build-time.** No dynamic plugin loading. An
  adapter loaded at runtime from a path the measured party can write to is
  `unattested-client` whatever it declares.
- **The standalone addon keeps working without Desktop Studio.** That is the
  product decision already taken: *"if user just does the electron app, they
  don't need the plugin, and can still have the optionality."* The reverse must
  also hold — the plugin alone stays a product. Two products, mirrored.

## The two products, and the honest difference between them

Both must be expressible on a leaf, and the difference must be **visible in the
record** rather than in a sales conversation.

| the user has | byte coverage of the AI step | the graph | model fingerprints | scene semantics |
|---|---|---|---|---|
| addon only | **none** — the bridge talks to ComfyUI directly | no | no | yes |
| Desktop Studio only | complete | yes | yes | **no** (`blind`) |
| both | complete | yes | yes | yes (`supplied`) — WO-E4, measured |
| both, **and the generation starts in Blender** | complete | yes | yes | yes — WO-E6, measured, with a third-party bridge |

⚑ Row 4 is not row 3 with a nicer story. In row 3 the generation was submitted
by this app and the announcement was driven by its driver; in row 4 a bridge
nobody here wrote submitted it, from inside Blender, at an address the kernel
allocated to the gate a minute earlier. What has to be true for row 4 and not
for row 3 is that the integration surface really is one string.

⚑ **Row 1 is the one to get right.** The addon alone can sign and witness the
Blender output, and it must **not** imply anything about the AI step it did not
observe. "Something was imported here and we do not know what it was" is the
true statement, and it needs to be on the leaf, not in a footnote.

_WO-E7, 2026-09-09: **all four rows have now been put on the table at once**,
one real leaf each, compared column by column — and two cells of the table above
are wrong._

- ⚑ **Row 1's flagged sentence is NOT satisfied.** The add-on-alone leaf does
  not imply anything about the AI step; it says **nothing** about it, and
  nothing is not the same as the true statement above. `host_semantics` reads
  **NULL** rather than `blind` — migration 058's *"the question was never asked
  of this leaf"* — because the add-on is a plugin and not a component, so it has
  no capture block at all. Measured by rendering the **same scene** around two
  **different** AI outputs: every provenance-bearing column is byte-identical
  across the two leaves and only the digest of the pixels moves. Finding
  **E7-1**, `docs/WO-E7.md`, and it is the finding the E-series ends on.
- ⚑ **"the graph: no" in row 1 is wrong at the column level.** The add-on sends
  a graph too — its own nine-key render-settings dict — and `workflow_hash` is
  non-null on all three products, in the same column, under the same
  `canonicalization_profile`, on the same `leaf_kind`. The route hashes the
  graph and **discards it**, so nothing on the leaf says which kind it was. What
  the row means is "no *ComfyUI* graph"; what the record says is less.
- **What the table gets right and the measurement confirms**: byte coverage,
  model fingerprints and scene semantics all read exactly as predicted, and
  `model_fingerprints_hash` is **byte-identical** between rows 2 and 3 — the two
  products that see the weights agree on them.
- **Two differences the table does not predict at all**, asserted by the gate so
  they stay visible: `leaf_scheme` is `v2.2` from the add-on and `v2` from the
  component (**E7-5** — two differently *constructed* leaves, not two
  differently populated ones), and `machine_manifest_hash` is set by the add-on
  and NULL from the component (**E7-6** — on that one column the standalone
  product records *more*).

The comparison is `python3 scripts/e7-leaf-diff.py`, and it does not list the
columns that came out interesting: **every one of the 105 columns of
`iterations` is in exactly one of five classes and an unclassified column is a
failure**, so the next migration that adds one forces somebody to decide.

## Blender on this box

_Rewritten by WO-E3, 2026-09-09, from measurements. What stood here before was
written from the two declared minimums and one of its two sentences was wrong._

`/usr/bin/blender` is **3.0.1**, and it stays 3.0.1 — WO-E3's control needs it.
Beside it, in this repo's own tree, is **Blender 4.2.23 LTS**:
`vendor/blender/bin/blender`, put there by `scripts/e3-install-blender.sh` and
gitignored. The manifest path — the one 4.2+ users actually get — now runs
here, proved by `scripts/e3-gate.sh`.

Two claims, and only one of them survived contact:

- ✅ **The manifest path did not exist on this box, and now does.** 3.0.1 has
  no extensions system at all: `"extensions" in dir(bpy.ops)` is `False` and
  `bpy.context.preferences.extensions` is absent. The zip could only ever
  arrive there as a classic addon under `scripts/addons/`, read through
  `bl_info`. On 4.2.23 it installs as `bl_ext.user_default.scruple_blender`,
  and the running Blender reports the floor as `(4, 2, 0)` and the description
  as the manifest's `tagline` — both of which differ from `bl_info`'s, so the
  reported values name the file Blender actually read.
- ❌ ⚑ **"The installed Blender cannot load the addon we ship" is FALSE.**
  Measured: 3.0.1 installs and enables the shipped zip, `enable()` raises
  nothing, and all six `SCRUPLE_PT_*` panels register — *despite* `bl_info`
  declaring `"blender": (3, 6, 0)`. Blender's `addon_utils.enable()` never
  reads that field. On the legacy path the declared minimum is **advisory**:
  shown in the preferences UI and enforced by nothing.

The floor that **is** enforced is `blender_manifest.toml`'s, and only on 4.2+.
Moving it to `4.9.0` gets the same zip refused by 4.2.23 with nothing left on
disk and no fall back to `bl_info`. So the addon's shipping story is: 4.2+
users are version-gated by the manifest; 3.x users are not gated at all and
will load an addon built against an API three years newer than theirs. Whether
`register()` should refuse below its own declared minimum is a product decision
WO-E3 did not take — it is finding **E3-1** in `docs/WO-E3.md`.

⚑ **blender.org publishes no Linux ARM64 build**, and this box is `aarch64`.
Checked 2026-09-09 across the 4.2, 4.3, 4.4 and 4.5 release directories: each
carries `linux-x64` and nothing else, and Ubuntu jammy's arm64 archive tops out
at the 3.0.1 already here. The official `linux-x64` tarball is therefore
installed unmodified, digest-checked, and run under `qemu-user` against an
amd64 sysroot built in the same tree. Blender reports its own version through
that shim and the addon loads through it, but **every Blender measurement in
this series is taken on an emulated CPU** — recorded as finding **E3-2**.

## The region in the dashboard

_WO-E5, 2026-09-09._ `docs/STATE.md` §0 opened with **"Blender is not installed
in this app"** and pointed at `app/ipc-profile.js` reporting `available: false,
detail: "not installed in this app yet"`. That sentence is retired, and what
replaced it is a **measurement**, not a better sentence.

The dashboard now has a Blender region, and it exists only when this machine
has a Blender. That required one new thing and only one: the host announces
what it has (`x-scruple-host-apps`, built in the main process from
`fs.existsSync`, beside the `x-scruple-profile` header WO-D5 already sent), and
`GET /api/v2/capabilities` decides the region from the announcement. The server
was never able to answer "is there a Blender on your laptop" and does not start
now — it is told, and it records that it was told.

Inside the region, three readings, each over the preload bridge and each with
its own state:

| what | where it comes from |
|---|---|
| the version | `blender --version` — **the running binary**, not `bl_info`, not the manifest, not a path |
| the addon's enabled state | `bpy.context.preferences.addons` inside a headless Blender that loaded the profile |
| whether a bridge is pointed at the gate | an address read out of a **bridge addon's own preferences**, compared against the port the gate allocated from the kernel |

⚑ **The region is ABSENT when there is no Blender** — `count === 0` and zero
occurrences in the serialised document, the WO-D5 rule unchanged. What is *not*
absent is the app: `compute` keeps its Blender entry, marked unavailable with
the reason, because STATE.md §0's other sentence — *"a dashboard that quietly
omitted them would be the failure mode"* — is still binding. The **panel of
readings nobody took** is what disappears.

⚑ **And the announcement is not a measurement.** A host that announces a Blender
it does not have gets its region drawn, and every reading inside it says
`none found` / `unread`. That is measured, not argued —
`scenarios/blender-absent.json`'s second mutation — and it is the honest limit
of a host-announced region. `docs/WO-E5.md` finding E5-1.

## Where the bridge fits

The research (`/data/scruple-blender/docs/canon/blender-l2/09-BLENDER-COMFYUI-RUNTIME.md`)
found eleven Blender↔ComfyUI bridges, and every one of them ultimately posts to
a ComfyUI address the user configures. That address is the whole integration
surface: point it at the gate and the bridge is captured with no code from us,
which is Level 1. The addon announcing the scene on top of it is Level 2.

We do not fork a bridge, vendor one, or ask users to switch. If a bridge cannot
be pointed at an arbitrary address, that is a finding about that bridge.

_WO-E6, 2026-09-09: **one of the eleven has now been run**, not reasoned about._
**`alexisrolland/ComfyUI-Blender` v3.3.4** — second by adoption, and the one
whose architecture is "a client pointed at a ComfyUI address" — was installed
from its own release zip, unmodified, digest-pinned in
`scripts/e6-install-bridge.sh`. Setting **one string** in its preferences to the
gate's address was the entire integration: it POSTed `/prompt` there, opened its
`/ws` there and downloaded the result from `/view` there, and the leaf carries
the graph. Nothing was forked, vendored or patched, and `app/comfy/` did not
change. `docs/WO-E6.md` records which other bridges were considered and why this
one, and the two things it does that `HOST-HOOK.md` did not expect (E6-1, E6-2).

## One leaf, both halves, from a generation nobody here started

_WO-E6, 2026-09-09._ The claim at the top of this document, as a row in a
database, from a run in which **this repository submitted nothing**:

```
   id            leaf_kind = workflow
   workflow_hash 4d68…      the body the BRIDGE POSTed — recomputed here from
                            its own client_id with the SDK's own hashWorkflow
   model_…hash   c6c3…      over upscale_models/scruple-tiny-x2.safetensors,
                            hashed by the DESKTOP from the file ComfyUI loaded
   host          blender    host_semantics = supplied
   host_evidence {"camera":"CAM_hero","engine":"BLENDER_EEVEE_NEXT",…,
                  "scene":"atrium-<nonce>"}  — out of bpy datablocks
```

`scenarios/blender-generate.json`, and `scripts/e6-gate.sh` reads it back with
`sha256sum` and `sqlite3` from the shell, outside node, because a driver that
grades its own run is a log line with extra steps.

## The mirror, and the two places it is cracked

_WO-E7, 2026-09-09, and this is where the E-series stops._

The product decision at the top of this document — *"the plugin alone stays a
product"* — was tested rather than restated. The add-on was run on its own,
against the server, with no gate anywhere in the path, on a scene built around
an AI output it never saw; and the leaf it produced was put beside a
Desktop-Studio-only leaf and a both leaf, **column by column, all 105 of them**.

The mirror holds. Both halves work alone, both reach a leaf, and the leaf says
which product made it — `baseline_hash` is the tamper surface of the integration
that submitted, and it is the one column a verifier can use to tell them apart.

Two cracks, both measured, neither fixed here:

1. ⚑ **The standalone leaf does not declare its blindness.** Above, and
   `docs/WO-E7.md` finding **E7-1**. This is a change to the server's leaf, so
   it is not the add-on's to take, and `docs/STATE.md` §4.7 names the three
   options and recommends one.
2. ⚑ **The add-on's own Settings UI does not bind on the path it ships on.**
   `ScrupleAddonPreferences.bl_idname` is the legacy module name, so through
   `blender_manifest.toml` — the path WO-E3 made work and the one every 4.2+
   user gets — `addons[module].preferences` is **None**: no API-key field, no
   base-URL field, and `get_base_url()` falling back to `https://scruple.ai`.
   Measured with a control, same zip on both install paths
   (`scripts/e7-prefs-probe.py`). Finding **E7-2**, and it is one line.

Neither crack is in the *claim* this document is about. The first is the claim
being incompletely expressible; the second is the standalone product being
harder to use than anyone intended. Both are named here rather than left in a
report nobody reads.
