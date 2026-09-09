# AI in Blender — what people actually do, and what our capture surface actually sees

_2026-09-07._ Research + code reading, no code changed. Part 1 is a web
survey (sources cited inline). Part 2 is read directly against
`/data/scruple-blender` at the tree used for `STATE.md` (WO-B7,
`af95462` + close-out commit). Part 3 is a set of proposals, not a
design decision.

---

## 0 · The one-line finding

**Our three automatic triggers are all "Blender wrote a file to disk"
events (`render_complete`, `render_write`, `save_post`), plus one manual
"witness an export" button.** A large share of real AI-in-Blender usage
in 2026 is **not** that shape — it is a datablock materializing in memory
(`bpy.data.images`, generated in-place by Dream Textures / AI Render, no
file ever written) or a script building geometry directly through `bpy.ops`
/ `bpy.data` calls (BlenderGPT, LL3M, BlenderMCP's `execute_blender_code`).
**Neither of those produces a capture today. Nothing fires, nothing is
queued, nothing is refused-and-logged — the event simply does not exist
from the addon's point of view.** A third large category — text/image-to-3D
bridges (Meshy, Tripo, CSM, Rodin, Hunyuan3D) — *does* write a file, but
the write is an **import** into the scene, not a render/save/export, so it
is also invisible to the three hooks; the closest thing that fires is
`save_post` on the next `.blend` save, which witnesses the whole scene
with no record of what was imported or why.

The one specific defect flagged for verification — glTF being mislabelled
with USDZ's MIME type — **does not exist in the code as it stands**. See
§2.3.

---

## Part 1 — How people actually use AI in Blender

### 1.1 Text-to-3D / image-to-3D generators and their Blender bridges

This is the dominant category by every signal found — dedicated Blender
add-ons, Blender-Foundation-level sponsorship, and the newest MCP layer
all cluster here.

- **Meshy** ships an official "Meshy for Blender" add-on with a local
  "DCC Bridge" for one-click transfer of generated models; Meshy is
  described as the first AI 3D tool to be an official Blender Foundation
  sponsor. Since v0.6.0 the bridge needs no API key and texture
  generation happens on the web app, imported into Blender via the
  bridge. [Meshy Docs](https://docs.meshy.ai/en/blender-plugin/introduction),
  [Meshy x Blender](https://www.meshy.ai/blog/blender-ai-plugin)
- **Tripo3D** ("Tripo AI for Blender", official extension at
  `VAST-AI-Research/tripo-3d-for-blender`) generates from text, image, or
  multi-view, then an "Import Result" button pulls a textured mesh with
  UVs into the scene. [GitHub](https://github.com/VAST-AI-Research/tripo-3d-for-blender),
  [Tripo blog](https://www.tripo3d.ai/blog/tripo-blender-plugin-tutorial)
- **TripoSR** (open-weight single-image reconstruction) has a community
  Blender add-on that generates an OBJ/GLB mesh from one image, used as
  base geometry to be retopologized in Blender.
  [TripoSR AI](https://www.triposrai.com/posts/triposr-blender-addon-workflow-tutorial/)
- **CSM.ai** exports FBX/OBJ/GLTF, imported into Blender manually or via a
  BlenderMCP integration that lets an LLM drive both CSM generation and
  the Blender side. [CSM+Blender MCP](https://glama.ai/mcp/servers/CommonSenseMachines/blender-mcp)
- **Rodin (Hyper3D)** ships an official add-on (Deemos) supporting
  text/image generation, ControlNet-guided regeneration on selected
  objects, from inside Blender's UI, requiring Blender 4.0+.
  [Rodin Addon Docs](https://docs.deemos.dev/addon)
- **Hunyuan3D-2** ships `blender_addon.py` directly in Tencent's own repo:
  a client that talks to a locally-hosted FastAPI server, serializes the
  request, and imports the resulting model — generation itself never runs
  inside Blender's process. [Tencent-Hunyuan/Hunyuan3D-2](https://github.com/Tencent-Hunyuan/Hunyuan3D-2/blob/main/blender_addon.py)

**Mechanism, uniformly:** (a) a file is written — but by the *bridge*, to
a cache/download directory, via HTTP, not by any Blender render/save/export
path — followed immediately by (c) a script-driven import
(`bpy.ops.import_scene.gltf` / `.fbx`, `wm.obj_import`, etc.) that
creates mesh/material datablocks in the open scene. The generated file on
disk is usually incidental and transient; the thing the user keeps is the
in-scene datablock.

**Popularity:** high and rising — this is the category vendors compete on
(Meshy, Tripo, CSM, Rodin, Hunyuan3D, plus a wave of unofficial add-ons),
and it is the category with a Blender Foundation sponsorship attached to
it.

### 1.2 Diffusion models generating images inside Blender

- **Dream Textures** (`carson-katri/dream-textures`) runs Stable Diffusion
  locally and integrates into the Shader Editor and Image Editor —
  text-to-image, depth-guided texture-to-3D-object projection, inpainting,
  seamless-texture conversion. [GitHub](https://github.com/carson-katri/dream-textures)
- **AI Render** (`benrugg/AI-Render`) renders the current Blender scene
  and sends it to Stable Diffusion (Automatic1111 or a hosted API) as a
  guide image, returning a stylized image back into Blender; supports
  animating the SD settings across frames.
  [GitHub](https://github.com/benrugg/AI-Render)
- **Stability AI's own add-on** (`Stability-AI/stability-blender-addon-public`)
  shipped in 2023 as an official plugin; repository is still public.
  [GitHub](https://github.com/Stability-AI/stability-blender-addon-public)

**Mechanism:** (b) — a new image datablock, generated and displayed in
Blender's Image Editor. This is the addon family's whole selling point:
"no slowdown from a service," "iterate in the viewport." **UNVERIFIED
precisely how each addon constructs the datablock at the byte level** (I
did not read their source in this session), but the documented UX for all
three — generate, see it appear in the Image/Shader editor, then
optionally `Image > Save As` — is inconsistent with a mandatory file
write. A file only exists if and when the user separately saves the
image; nothing about the generation step itself requires disk I/O.

**Popularity:** Dream Textures is repeatedly named as one of the most
recommended Blender AI add-ons in 2026 roundups; it is the most-cited
name across every "best Blender AI tools" list found in this search.

### 1.3 ComfyUI ↔ Blender bridges

- **AIGODLIKE/ComfyUI-BlenderAI-node** turns ComfyUI's node graph into
  Blender-native nodes so the whole ComfyUI workflow runs without leaving
  Blender; used for "AI model generation... texture enhancement &
  generation." A companion, **ComfyUI-CUP**, bridges the two processes
  for thumbnails and queue management.
  [GitHub](https://github.com/AIGODLIKE/ComfyUI-BlenderAI-node),
  [ComfyUI-CUP](https://github.com/AIGODLIKE/ComfyUI-CUP)
- **Texturaizer** (Gumroad) integrates ComfyUI-driven, locally-run image
  generation directly as a Blender texture pipeline.

**Mechanism:** mixed (a)/(b) — ComfyUI itself writes output files to its
own `output/` directory (its normal behavior, outside Blender's process
and outside `bpy.path`), which the bridge then loads into a Blender image
datablock, sometimes re-encoded, sometimes referenced by path. Either way
the write, if any, happens through ComfyUI's own file I/O, never through
`scene.render` — so it is invisible to a Blender-render-shaped hook even
in the (a) case.

**Popularity:** large in the "power user" segment (people who already run
ComfyUI), smaller in absolute numbers than the hosted bridges in 1.1.

### 1.4 AI texture / PBR material generation

- **AI Material Factory** — Stable-Diffusion-driven PBR map generation
  (Blender Market).
- **StableGen** (`sakalond/StableGen`) — mesh-to-texture via TRELLIS.2 +
  SDXL, producing roughness/metallic/normal maps.
  [GitHub](https://github.com/sakalond/StableGen)
- **Texturology** (BlenderKit) — drop an image into the Image Editor, hit
  Generate, get seamless 2K–8K PBR maps.

**Mechanism:** (b), same as 1.2 — maps materialize as image datablocks
assigned into a material node tree; some tools additionally write a cache
file for the underlying diffusion model's own pipeline (not
user-visible, not under `bpy.path`).

**Popularity:** medium; smaller than 1.1/1.2 but a recurring entry in
every "Blender AI tools" roundup found.

### 1.5 LLM-driven scripting add-ons that write Python to build geometry

- **BlenderGPT** (`gd3kr/BlenderGPT`) — turns an English prompt into a
  generated Python script, executed inside Blender to build the scene.
  [GitHub](https://github.com/gd3kr/BlenderGPT)
- **LL3M** (`threedle/ll3m`) — multi-agent system, explicitly "writes
  interpretable Python code in Blender" to generate assets — an academic/
  research project but a clean statement of the mechanism.
  [GitHub](https://github.com/threedle/ll3m)
- **BlenderMCP** (`ahujasid/blender-mcp`) — connects Claude/GPT/Cursor to
  a running Blender over the Model Context Protocol. Its most-used
  capability is `execute_blender_code`: **the LLM sends arbitrary Python,
  and the addon `exec()`s it inside Blender's process.** It also drives
  Rodin, Poly Haven downloads, and scene edits through the same channel.
  [GitHub](https://github.com/ahujasid/blender-mcp)

**Mechanism:** (c), unambiguously — objects, meshes, modifiers, materials
built directly via `bpy.ops`/`bpy.data` calls inside a Python `exec()`
context. No file is written, no render happens, nothing resembles an
export. This is a pure in-process side effect.

**Popularity:** BlenderMCP is currently the dominant "LLM + Blender"
pattern — it generalizes far beyond BlenderGPT's single-purpose prompt
box (it also drives Rodin generation, texture downloads, and scene
queries through the same MCP channel), and several sources note
BlenderGPT's own search interest has fallen sharply as MCP-based tools
took over the niche. [BlenderMCP compare](https://blenderai.org/compare/best-blender-ai-assistant)

### 1.6 AI motion capture / animation retargeting from video

- **Rokoko Video / Rokoko Vision** — free browser-based video-to-3D-motion
  extraction, exported as FBX/BVH; Rokoko's Blender add-on then retargets
  bones onto a target rig. [Rokoko + Blender](https://www.rokoko.com/integrations/blender)
- **DeepMotion** — video → 3D animation or 2D image → 3D pose, "ready to
  be imported directly into scenes." [DeepMotion + Blender](https://www.deepmotion.com/companion-tools/blender)
- **Wonder Studio** (Wonder Dynamics, acquired by Autodesk in 2024,
  rebranded Autodesk Flow Studio in 2025) — tracks an actor in live-action
  footage and replaces them with a CG character, supporting custom
  Blender/Maya characters, shipping dedicated Blender/Maya plugins in
  late 2023. [CG Channel](https://www.cgchannel.com/2023/11/wonder-studio-gets-new-blender-and-maya-plugins/),
  [CG Channel — Flow Studio](https://www.cgchannel.com/2025/03/wonder-studio-becomes-autodesk-flow-studio/)

**Mechanism:** (a) a motion file (FBX/BVH) is written by the external
service, then (c)/(d) imported into Blender as armature/action data via
`bpy.ops.import_scene.fbx` / `import_anim.bvh` — an import, exactly like
1.1's meshes, not an export.

**Popularity:** medium-high in character-animation and VFX workflows
specifically; niche relative to the general Blender population.

### 1.7 AI denoising and upscaling — does it count as generative?

- **OIDN (Intel)** and **OptiX (NVIDIA)** are both ML-based denoisers
  built into Blender's render pipeline (Cycles final render, OptiX also
  in the viewport). They are explicitly **not generative** — they clean
  up an already-rendered image; they don't add content that wasn't
  implied by the samples taken.
  [RebusFarm denoising guide](https://rebusfarm.net/blog/ai-denoising-guide-nvidia-optix-intel-oidn-and-corona-denoiser-for-architects-and-3d-artists)
- **Topaz** (Video AI / Gigapixel) is used as an external, file-in/file-out
  step on rendered footage — not a Blender add-on at all.

**Decision for this report:** OIDN/OptiX count as **denoising, not
generation** — they run *inside* the render Blender already produces, and
their output *is* the file our render hooks already see. Treated
separately from the generative categories above; discussed in Part 2
purely for where they land in the capture surface.

**Popularity:** ubiquitous — OIDN/OptiX are default-on for a large share
of Cycles renders; far more universally used than any generative add-on
above, but a different kind of thing.

Sources for this Part are cited inline above; nothing here rests on
vendor marketing pages alone — GitHub repos, docs, and third-party
tutorials were preferred wherever an official page also existed.

---

## Part 2 — Would our flow capture it?

### 2.1 The real trigger list (verified against `adapter/handlers.py`)

```python
HANDLER_MAP = (
    ("render_complete", _on_render_complete),
    ("render_write",    _on_render_write),
    ("save_post",       _on_save_post),
)
```
`adapter/handlers.py:151-155`. That is the complete automatic set — three
`bpy.app.handlers` registrations, nothing else (no `load_post`, no
`depsgraph_update_post`, no `msgbus`). The fourth capture path is manual:
`operators/witness_export.py`'s `SCRUPLE_OT_witness_export`, invoked by
the user from the N-panel *after* running Blender's own exporter —
comment in the file states plainly that Blender's export operators "are
individual invocations rather than a hookable `export_post` list," so
even exports are not auto-wrapped (`operators/witness_export.py:5-9`).

All three automatic handlers, and the manual one, ultimately call
`scruple_host_sdk.capture.capture(path, mime=..., kind=..., workflow=...)`
(vendored at `/data/scruple-blender/vendor/scruple_host_sdk/capture.py`),
which does:

```python
if not path or not os.path.exists(path):
    raise FileNotFoundError(f"capture(): no file at {path!r}")
...
digest = sha256_file(path)
```
`vendor/scruple_api/capture.py:87-108`. **The capture function itself is
hard-wired to a file that must already exist on disk.** There is no
in-memory / bytes-object entry point anywhere in the shipped SDK. This
independently confirms the finding without relying on the handler list
alone: even if a fifth handler were added tomorrow for, say,
`depsgraph_update_post`, it still could not hand a `bpy.data.images`
datablock to `capture()` without first writing it to a file — the API
does not accept bytes.

### 2.2 The MIME tables (verified against `adapter/scene.py`)

Confirmed as given: `RENDER_FORMAT_MIME` (16 entries), `FFMPEG_CONTAINER_MIME`
(10 entries), `EXPORT_FORMAT_MIME` (8 entries: `obj fbx usd usdz stl ply
abc dae` — not `gltf`, see §2.3). Each table-miss path raises
`MimeRequiredError` rather than defaulting — `mime_for_render()` at
`adapter/scene.py:242-272` and `mime_for_export()` at
`adapter/scene.py:278-299` both end in an explicit raise with no
`application/octet-stream` fallback. `STATE.md` §1.1 independently
confirms this was exercised against real Blender: "an undeclared export
format raises `MimeRequiredError` in real Blender."

### 2.3 The flagged glTF/USDZ concern — **REFUTED**

`mime_for_export()`, `adapter/scene.py:278-299`:

```python
def mime_for_export(format: str, path: str = "", *, declared: Optional[str] = None) -> str:
    if declared and declared.strip():
        return declared.strip()
    key = (format or "").strip().lower()
    if key == "gltf":
        return "model/gltf-binary" if path.lower().endswith(".glb") else "model/gltf+json"
    if key == "usd" and path.lower().endswith(".usdz"):
        return EXPORT_FORMAT_MIME["usdz"]
    mime = EXPORT_FORMAT_MIME.get(key)
    ...
```

`"gltf"` is handled by its **own branch, before** the generic
`EXPORT_FORMAT_MIME.get(key)` lookup is ever reached, and returns
`model/gltf-binary` or `model/gltf+json` depending on the file's own
extension (`.glb` vs `.gltf`) — never `EXPORT_FORMAT_MIME["usdz"]`.
`EXPORT_FORMAT_MIME` itself has **no `"gltf"` key at all** — only `usd`
and `usdz` (distinct, correctly disambiguated by their own branch three
lines above it, based on whether the exported path ends `.usdz`). The
operator that calls this (`operators/witness_export.py`) defaults its
`format` `EnumProperty` to `"gltf"` (`FORMAT_ITEMS[0]`,
`witness_export.py:31`), so the single most likely real-world path —
export glTF, click "Witness this export" — resolves correctly today.

**Verdict: refuted.** There is no defect here. `git log -- adapter/scene.py`
shows this file has exactly two commits (`912afd5` WO-B2 introducing it,
`8c0da18` WO-B5 unrelated panel work); the gltf branch was correct from
introduction, not a regression that was later fixed.

### 2.4 Pattern-by-pattern verdict

| Part 1 pattern | Verdict | Why, with file:line |
|---|---|---|
| **1.1 Text/image-to-3D bridges** (Meshy, Tripo, CSM, Rodin, Hunyuan3D, TripoSR) | **Not captured at generation. Partially captured indirectly, on the next `.blend` save, with no provenance link.** | The bridge's own HTTP download and the subsequent `bpy.ops.import_scene.*` call are neither a render, a save, nor an export — none of `HANDLER_MAP` (`adapter/handlers.py:151-155`) fires. If the user later saves the `.blend`, `_on_save_post` (`handlers.py:136-148`) fires and witnesses the whole file as `kind="save"` → leaf `document_save` (`adapter/flow.py`'s `CAPTURE_KIND`), but `build_save_workflow()` (`adapter/scene.py:398-414`) only records `filepath, scene, object_count, material_count` — nothing that says a mesh came from Meshy/Tripo/Rodin, nothing about the prompt or source service. The user *could* manually invoke `SCRUPLE_OT_witness_export` on the bridge's downloaded `.glb`/`.fbx` before importing it (the operator just hashes whatever `filepath` it is given — it does not check that the file was actually exported by Blender, `witness_export.py:55-73`), but nothing prompts them to, and the label ("Witness this export") is semantically backwards for an import. |
| **1.2 Diffusion images generated in-place** (Dream Textures, AI Render, Stability add-on) | **Not captured at all.** | The image lands as a `bpy.data.images` datablock with no file ever written by Blender. No handler exists for image-datablock creation (`HANDLER_MAP` has three entries, none of them image- or datablock-shaped). Even a future hook could not hand the result to `capture()` — `vendor/scruple_api/capture.py:87-89` raises `FileNotFoundError` unless `os.path.exists(path)` is already true. If the user separately does `Image > Save As`, that write still triggers nothing — there is no `image_save_post` in Blender's own `bpy.app.handlers`, and the addon subscribes to none of the handlers that do exist beyond the three named. |
| **1.3 ComfyUI ↔ Blender bridges** | **Not captured at all**, same reasoning as 1.2 — even where ComfyUI itself writes a file, that write happens in ComfyUI's own `output/` directory via ComfyUI's process, not through `scene.render` or `bpy.ops.wm.save_mainfile`, so no handler in `HANDLER_MAP` observes it. |
| **1.4 AI texture/PBR generation** | **Not captured at all**, identical to 1.2 — image/material datablocks, no automatic hook. |
| **1.5 LLM-scripting add-ons** (BlenderGPT, LL3M, BlenderMCP `execute_blender_code`) | **Not captured at all, and worse than 1.1–1.4: no file is even eventually produced unless the user separately saves or renders.** | Geometry is built directly through `bpy.ops`/`bpy.data` inside a Python `exec()` — pattern (c) with zero file I/O anywhere in the chain. Nothing in `handlers.py` observes operator execution, `exec()` calls, or arbitrary `bpy.data` mutation. If the user later saves, `_on_save_post` fires exactly as in 1.1, with the same blindness: `build_save_workflow()`'s `object_count`/`material_count` (`scene.py:398-414`) says nothing about how those objects were made. |
| **1.6 AI motion capture / retargeting** | **Not captured at import; partially captured, opaquely, on next save** — identical reasoning to 1.1: the FBX/BVH import is neither render, save, nor export. |
| **1.7 AI denoising (OIDN/OptiX)** | **Captured, but silently folded in — not distinctly recorded.** | Denoising runs inside Cycles' own render pipeline before the file lands on disk, so whichever handler fires (`render_complete`/`render_write`) hashes the *already-denoised* pixels — the leaf is real and its `content_hash` is correct for what's on disk. But `build_render_workflow()` (`adapter/scene.py:369-394`) captures `engine, resolution, samples, camera, frame, trigger` and nothing about `use_denoising` or which denoiser ran, so the leaf can't distinguish an AI-denoised render from a raw one. Topaz (external, file-in/file-out on an already-exported render) is a plain file rename/replace outside Blender entirely — invisible unless the user manually witnesses the Topaz output via `SCRUPLE_OT_witness_export`, and even then `"other"` format requires a hand-typed MIME (`witness_export.py:31-37`, `FORMAT_ITEMS`). |

**The interesting failure mode, confirmed as asked:** 1.2, 1.3, 1.4, and
1.5 — diffusion-image generation, ComfyUI bridges, PBR generation, and
LLM scripting — are **all four fully invisible to the addon today**, not
degraded, not partial: no leaf, no queued-but-failed entry, no
`MimeRequiredError` refusal that at least surfaces the gap. `capture()`'s
hard file-existence check (`vendor/scruple_api/capture.py:88-89`) means
these events don't even reach the point where the addon could refuse them
honestly — they never reach the addon's code at all. This matches
CANON_SKELETON's own framing of an adapter's job ("mapping its host's
vocabulary onto these hooks") — the gap is that Blender's `bpy.app.handlers`
vocabulary genuinely has **no entry** for "a datablock was created" or "a
script ran," so there is no host vocabulary to map from without a
different mechanism (Part 3).

---

## Part 3 — Proposals for the real gaps

Constraints restated from `L2_FLOOR.md` and `CANON_SKELETON.md`, applied
to each proposal below: MIME must be declared from something real, never
guessed (`CANON_SKELETON.md` D-8's sibling property, enforced today by
`require_mime()`, `vendor/scruple_api/capture.py:44-70`); the leaf commits
to a content hash, so whatever is captured must hash deterministically;
an adapter may not assemble its own envelope (§5) — every proposal below
still routes through `Client.witness_file()` / `capture()`, never a
hand-built payload; and refusing honestly beats recording something
unverifiable.

### P1 — Generalize "witness an export" into "witness a file" (covers 1.1, 1.6, half of 1.7)

**Mechanism:** No new `bpy.app.handlers` hook needed. Rename/extend the
existing `SCRUPLE_OT_witness_export` (`operators/witness_export.py`) so
its file-selector defaults to the last-modified file in the common bridge
cache directories users already have configured (Meshy DCC Bridge,
Tripo's local cache, Rodin's download folder, Rokoko/DeepMotion export
folders) — or, more simply, just relabel the button "Witness an
AI-generated file" and stop implying it's export-only, since
`mime_for_export()` already has no opinion about whether the file came
from Blender's own exporter or a third-party bridge's download; it only
hashes what's at the path. Add explicit `EXPORT_FORMAT_MIME` rows the
bridges actually produce that aren't covered yet: none are missing today
for the common cases (`obj`, `fbx`, `usd/usdz` are covered; `gltf` has its
own correct branch per §2.3) — the gap is UX/discoverability, not the
MIME table.

**Hashing:** unchanged — `sha256_file()` on a real path, exactly as today.

**Cost:** near-zero. No new capture path, no new hashing, no new envelope.
One label change plus, optionally, a "recent downloads" convenience list.

**What it still misses:** it is still a manual click. It captures the
*file* (a `.glb`/`.fbx` at rest), not the fact that it came from a
specific AI service or prompt — `build_export_workflow()`
(`adapter/scene.py:418-434`) has an `options` dict that could carry a
`source: "meshy" / "tripo" / "rodin"` field if the user or a cooperating
bridge supplied it, but nothing today infers that automatically, and this
proposal does not add automatic inference — it stays honest about being a
manual, undated declaration by the user, not a detected fact.

**Rank: do this first.** It is the cheapest proposal here and it directly
addresses the single largest cluster of real usage found in Part 1
(text/image-to-3D bridges), plus mocap import (1.6) for free, using
mechanics that already exist and are already proven in `STATE.md` §1.1.

### P2 — Record denoiser state on the render leaf (covers the rest of 1.7)

**Mechanism:** No new hook. Add two fields to `build_render_workflow()`
(`adapter/scene.py:369-394`): read `scene.cycles.use_denoising` /
`scene.eevee.use_gtao`-equivalent and, where available,
`scene.cycles.denoiser` (`OPENIMAGEDENOISE` / `OPTIX`), the same way
`read_render_settings()` already reads `samples` from `cycles`/`eevee`
sub-blocks (`scene.py:319-343`).

**Hashing:** none needed — this is metadata riding on a capture that
already happens and already hashes the real output file.

**Cost:** trivial — a few lines in an existing function, two more workflow
dict keys, both already covered by the leaf's existing `workflow_hash`
machinery.

**What it still misses:** it does not capture Topaz or any denoiser that
runs *outside* Blender's own render pipeline after export — that case
still needs P1 (manual witness of the Topaz output file).

**Rank: second.** Even cheaper than P1 in engineering terms, but it
addresses the smallest gap (denoising is already captured; this only adds
honesty about what ran), and it is not usage-shaped the way P1 is —
almost nobody asks "was this AI-denoised" the way they ask "does this
prove the mesh came from an AI generator."

### P3 — A manual "witness the generated image" operator using `Image.pack()` (covers 1.2, 1.4, part of 1.3)

**Mechanism:** `bpy.types.Image.pack()` is Blender's own native operation
for embedding an image's encoded bytes (its `packed_file.data` buffer,
typically PNG-encoded) into the `.blend` without ever touching a separate
file on disk — this is exactly the "hashable deterministically, no disk
file required" primitive the constraint asks for, and it's Blender's own
mechanism, not a workaround invented here. A new manual operator (siblings
to `SCRUPLE_OT_witness_export`) would: take the active `Image` in the
Image/Shader Editor, call `image.pack()` if not already packed, read
`image.packed_file.data` (bytes, in memory), `sha256` those bytes
directly (no file I/O — `hashlib.sha256(bytes(image.packed_file.data)).hexdigest()`,
new code, not the existing `sha256_file()` which needs a path), declare
`mime="image/png"` explicitly (Blender's default pack format for a
generated image is PNG; this would need confirming per-image via
`image.file_format`, which **is** a real, read, declared value exactly
like `render_file_format()` already reads for renders — same pattern,
new table: `PACK_FORMAT_MIME` mirroring `RENDER_FORMAT_MIME`, refusing on
an unmapped format exactly as `mime_for_render()` does today), and hand
the raw bytes to a bytes-accepting sibling of `capture()` (a new SDK
entry point — the current `capture()` hard-requires a path,
`vendor/scruple_api/capture.py:87-89`, so this is not free: it needs an
SDK-side change, which is out of adapter scope per CANON_SKELETON §5 and
would need to happen in `scruple_api`/`scruple_host_sdk` itself, not in
the addon).

**Cost:** moderate. Real code: a new bytes-capture entry point in the
vendored SDK (cross-repo change, not adapter-only), a new format table, a
new operator, and a decision about what "kind" this is on the closed v2
leaf enum (`document_save` / `artifact` / `graph_execute` / `model_write`
— `adapter/flow.py`'s `LEAF_KINDS`) since "a packed image datablock" maps
most naturally to `artifact` but that is a judgment call, not a given.

**What it still misses:** still manual — Blender has no hook that fires
when an addon like Dream Textures creates an image, so there is no way to
make this automatic without either (a) monkeypatching/wrapping
`bpy.data.images.new` globally, which is fragile, would break on any
Blender API change, and captures every image any addon or the user ever
creates including ones with nothing to do with AI (false positives,
massive noise), or (b) a cooperative API those third-party add-ons would
have to call into voluntarily (see P4). This proposal is honest about
being opt-in per-image, not automatic detection.

**Rank: third.** Real coverage of a real, popular category (1.2/1.4, and
half of 1.3), but the cost is genuinely cross-repo and the result is
still a manual step a user has to remember to take — lower value per
dollar than P1.

### P4 — A cooperative "please tell us" API for script-shaped and bridge-shaped add-ons (covers 1.5, automates 1.1/1.2/1.3/1.4)

**Mechanism:** Expose one function, e.g. `scruple_blender.notify(kind, path_or_bytes, mime, workflow)`,
that any third-party add-on (BlenderGPT, LL3M, BlenderMCP, Dream
Textures, a Meshy/Tripo bridge) could call after it finishes generating,
routed through the exact same `capture()` → `witness_file()` machinery as
everything else — no new envelope assembly, still §5-compliant, because
it is just a new call site into the same pipeline, driven by the
producing add-on instead of by a Blender core hook. This is the only
proposal that can reach 1.5 (LLM-scripted geometry) at all, since there
is genuinely no Blender-core signal for "a script ran" that isn't also
"literally any operator ran" — `depsgraph_update_post` fires on every
scene edit a human makes too, so it cannot distinguish AI-authored
changes from manual ones without the producing code self-identifying.

**Cost:** high, and **not entirely ours to pay** — it requires each
third-party add-on's maintainer to add a call, or requires us to fork/
patch each one (BlenderGPT, LL3M, and BlenderMCP are all separate
open-source projects under separate maintainers; Meshy/Tripo/Rodin are
closed, official add-ons we cannot patch at all). This is a multi-party
integration effort, not an engineering task inside `/data/scruple-blender`.

**What it still misses:** any add-on that doesn't cooperate — which,
realistically, is most of them, most of the time, at least at first. This
is the correct long-term answer for 1.5 specifically (nothing else in
this list can capture it), but it is not a near-term fix.

**Rank: fourth / long-term.** Highest ceiling (the only path to 1.5 at
all) but the least within our control and the most expensive to make real
coverage of rather than a theoretical API nobody calls.

### Rejected: `depsgraph_update_post` as a general-purpose "something changed" net

Considered and rejected for the same reason named in P4: it fires
constantly, on every human edit as much as every AI one, so it cannot
attribute cause, and recording "some data changed at time T" with no
verifiable claim about what or why is exactly the unverifiable-record
case `L2_FLOOR.md` and the "refuse honestly" instruction warn against. It
was not pursued further than this paragraph.

### Ranked summary

| Rank | Proposal | Covers | Cost | Automatic? |
|---|---|---|---|---|
| 1 | P1 — generalize witness-export to witness-any-file | 1.1, 1.6, Topaz-half of 1.7 | near-zero | no (manual, but cheap enough to prompt for) |
| 2 | P2 — record denoiser state on render leaf | rest of 1.7 | trivial | yes |
| 3 | P3 — `Image.pack()`-based manual datablock witness | 1.2, 1.4, half of 1.3 | moderate, cross-repo | no |
| 4 | P4 — cooperative notify() API | 1.5, and automates 1.1–1.4 | high, multi-party | yes, if adopted |

**Do P1 first.** It is the only proposal that is both cheap and aimed at
the single largest real-usage category found in Part 1, it reuses a code
path already proven end-to-end in `STATE.md` §1.1, and it requires no SDK
change, no new hashing routine, and no cross-repo coordination — just a
relabeling and a small discoverability improvement to a button that
already exists.
