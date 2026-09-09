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

⚑ **Row 1 is the one to get right.** The addon alone can sign and witness the
Blender output, and it must **not** imply anything about the AI step it did not
observe. "Something was imported here and we do not know what it was" is the
true statement, and it needs to be on the leaf, not in a footnote.

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

## Where the bridge fits

The research (`/data/scruple-blender/docs/canon/09-BLENDER-COMFYUI-RUNTIME.md`)
found eleven Blender↔ComfyUI bridges, and every one of them ultimately posts to
a ComfyUI address the user configures. That address is the whole integration
surface: point it at the gate and the bridge is captured with no code from us,
which is Level 1. The addon announcing the scene on top of it is Level 2.

We do not fork a bridge, vendor one, or ask users to switch. If a bridge cannot
be pointed at an arbitrary address, that is a finding about that bridge.
