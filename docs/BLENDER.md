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
| `host_semantics` on its leaves | n/a — not a component leaf | `blind` today |

The E-series makes the addon the **Level-2 adapter** for the gate, so the two
halves land on one leaf.

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
| both | complete | yes | yes | yes (`supplied`) |

⚑ **Row 1 is the one to get right.** The addon alone can sign and witness the
Blender output, and it must **not** imply anything about the AI step it did not
observe. "Something was imported here and we do not know what it was" is the
true statement, and it needs to be on the leaf, not in a footnote.

## Blender on this box

🔴 `/usr/bin/blender` is **3.0.1**. The addon's own `bl_info` declares
`"blender": (3, 6, 0)` and `blender_manifest.toml` declares
`blender_version_min = "4.2.0"`. **The installed Blender cannot load the addon
we ship**, and the manifest path — the one 4.2+ users actually get — has never
run here. WO-E3 exists because of this and nothing downstream is trustworthy
until it passes.

## Where the bridge fits

The research (`/data/scruple-blender/docs/canon/09-BLENDER-COMFYUI-RUNTIME.md`)
found eleven Blender↔ComfyUI bridges, and every one of them ultimately posts to
a ComfyUI address the user configures. That address is the whole integration
surface: point it at the gate and the bridge is captured with no code from us,
which is Level 1. The addon announcing the scene on top of it is Level 2.

We do not fork a bridge, vendor one, or ask users to switch. If a bridge cannot
be pointed at an arbitrary address, that is a finding about that bridge.
