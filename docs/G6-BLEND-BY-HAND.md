# WO-G6 — how a `.blend` changes without us seeing it

_2026-09-10. Everything marked **MEASURED** was executed against Blender 4.2.23
with the add-on loaded. Everything marked **READ** comes from source or
documentation and was not run. The two are never mixed._

The work order's control: **at least one case must be found that the add-on does
not notice, or the investigation is not finished.** Two were found, they are
independent of each other, and neither is an attack.

---

## First, the community reality

A `.blend` is **not a document format — it is a memory dump.** Blender writes its
in-memory structs to disk with real pointer values used as identity keys. What
makes it tractable from outside is that **the file describes its own layout**: a
`DNA1` block lists every struct definition in the version that wrote it. That is
how Blender opens a file from 2005, and the side effect is that anyone can parse
a `.blend` correctly without knowing anything about Blender.

**MEASURED:** the Blender 4.2 we vendor ships `4.2/scripts/modules/blend_render_info.py`
— a first-party parser that opens a `.blend`, handles gzip and zstd, and walks
the block structure **without running Blender**. Read-only, but it is Blender's
own code treating the format as readable from outside.

So editing a `.blend` externally is not an exotic act. It is an established
pipeline technique, and the canonical use is **path remapping**: a `.blend`
refers to textures and libraries by path, and moving a project between machines
or onto a render farm invalidates every one of them.

---

## HOLE 1 — the Blender Asset Tracer · **MEASURED**

**`blender-asset-tracer` (BAT), v1.20, `sybren@blender.org`, GPL-2.0+.** The tool
Blender Studio's own render farm uses. `bat pack shot.blend /farm/` is what a
studio tells an artist to run.

**MEASURED, from the published package:**

| | |
|---|---|
| `bl_info` (the add-on marker) | **absent** |
| imports `bpy` | **never**, in any of 37 modules |
| `register()` / `unregister()` | **absent** |
| how you run it | `bat`, a shell command |

**It is not a Blender add-on.** So the add-on set WO-G5 baselines cannot contain
it and never will, Blender is not running so no handler fires, and nothing about
the machine's Blender install changes.

**MEASURED on a real pack** — a cube with a texture living outside the project
directory, packed with `bat pack`:

```
original   e1bcedf378db8aec4fdb   895976 bytes
packed     2fdd4c96418fb32e5f70   895976 bytes
IDENTICAL? False
```

⚑ **Same byte count, different hash.** Paths live in fixed-size character arrays,
so the file length does not move. **A size check sees nothing.**

### And the distinction that saves it

**MEASURED**, reading the same two files with the add-on's own enumerator:

```
before  asset wood.png  digest 07e011c05372258cb07a
after   asset wood.png  digest 07e011c05372258cb07a
the .blend changed      -> True
the ASSET BYTES changed -> False
```

BAT rewrites **where** an asset lives. It does not rewrite **what** it is. WO-F3's
record already carries this, because it hashes contents rather than paths — so a
repath and a swap are separable, and only one of them should worry anybody.

### What we did about it

**We host it rather than detect it.** Detection is a losing game against a
first-party utility that is *meant* to be used. A tool the app runs is a tool the
app can witness — `app/ipc-bat.js`, surfaced as an **Assets** sub-tab in the
Blender tab. No install: BAT is pure Python and wants `requests`, which Blender's
bundled Python already has (**MEASURED**: Python 3.11.7, `requests` present,
`zstandard` present).

🔴 **A verdict I nearly shipped wrong.** The first version compared the pack's
input to its output and said "content unchanged" — true, and useless. Both
readings are taken at pack time, so a texture swapped an hour earlier is in both
and the pack correctly calls itself a repath. Read as *"nothing has changed since
we witnessed this"* — which is how anyone would read it — it is false. Two actions
now, with the scope stamped into the payload:

| action | answers |
|---|---|
| `pack` → `scope: this_operation` | "this pack changed no content" |
| `compare` → `scope: since_witnessed` | "nothing has changed since we witnessed it" |

**MEASURED**, the control: swap the texture bytes, then `compare` against the
witnessed record → `content_changed`, naming `wood.png`. Same comparison with
nothing touched → `unchanged`. The must-fire and the must-NOT-fire both behave.

---

## HOLE 2 — `bpy.data.libraries.write()` · **MEASURED**

Inside Blender. Add-on loaded. Handlers registered. **And it still does not fire.**

**MEASURED**, with the add-on's real handlers wrapped and counted:

```
wrapped 2 handler(s)
registered: save_post ['_on_save_post'] · load_post ['_on_blendfile_load_post']

save_from_script    {'save_post': 1}     ← seen
edit_then_save      {'save_post': 1}     ← seen
libraries_write     NOTHING FIRED        ← 🔴 and it produced a file
```

`bpy.data.libraries.write()` is the documented way to write a partial `.blend`.
It is not the save operator, so `save_post` is not on its path. A script inside
Blender can write a `.blend` and the add-on will never know.

⚑ **The instrumentation itself needed a control.** My first probe filtered
handlers on the string `"scruple"` — but they are named `_on_save_post` in module
`adapter.handlers`, so it wrapped **nothing** and reported zero fires for
everything. That reads exactly like "no handler ran." `wrapped_count` is now in
the output: a run that wrapped nothing measured nothing.

---

## What the add-on watches, and what that implies

**MEASURED:** the add-on registers on `save_post` and `load_post`. **Nothing on
`depsgraph_update_post`.**

So the record is of **saves, not of work**. Everything between two saves is a
single opaque step. The vendor-standard note predicted this — *"Fusion's
`auto_witness` is the correct pattern; Blender's manual triggers are a known
weakness"* — and it is now measured rather than expected. For a claim that rests
on **continuity**, a per-save record is the sparse record the strategy warns is
worth nothing on its own.

---

## The remaining classes — **READ, not measured**

Named honestly as unfinished. Each is a candidate for the next pass.

| Method | Expected visibility | Why it matters |
|---|---|---|
| `blender --background --python edit.py` | **seen IF the add-on is enabled in that profile** — and `--factory-startup` disables it | the add-on's own presence is the variable |
| Text Editor script with **Register** / auto-run on load | unknown | runs before handlers may be attached |
| Drivers and expressions | likely unseen | recompute on load; change results without a save |
| Linked libraries | partially | the `.blend` is unchanged; the *library* moves |
| Appending from another `.blend` | seen at next save | arrives as datablocks WO-F3 enumerates |
| Pack / unpack images | seen at next save | but changes `digest_of` between packed and source bytes |

⚑ The linked-library row is the one worth a session of its own: **the witnessed
file need not change at all** for its content to change, because the content
lives somewhere else.

---

## Which are normal work and which are evasion

**Almost all of them are normal work.** `bat pack` is a render-farm instruction.
`libraries.write` is how asset libraries are built. Linking is how a studio shares
a rig.

That reframes the question the work order started with. It is not *"can they edit
it behind our back"* — they can, and often should. It is:

> **can the record tell a relocation from a substitution?**

**MEASURED: yes, for assets** — because the record hashes contents, not paths, and
that survived a real `bat pack` unchanged. **Not established for anything else**,
and the honest limit is that `origin_observed` is `False` at every door in this
estate: nobody watched the imports arrive.

---

## What this costs the no-AI claim

WO-G5 derives a non-AI `digitalSourceType` from the completeness of the record.
G6 says plainly what that record does not cover:

1. **A `.blend` can be rewritten with Blender closed** by a first-party tool that
   is not an add-on. *Mitigated* by hosting BAT — but only when the user runs it
   through us.
2. **A script inside Blender can write a `.blend` with no handler firing.** Not
   mitigated.
3. **Only saves are witnessed, not work.** Not mitigated, and it is structural.

**None of these is a reason to stop making the claim. All of them are reasons the
claim must say what it covers.** A record that is complete *as far as it looks*
is the failure mode this whole series exists to avoid.
