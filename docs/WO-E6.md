# WO-E6 — one generation, from inside Blender, through the gate

_2026-09-09. Desktop repo only: the server repo and the addon repo are
untouched, and `app/comfy/` is byte-identical to WO-E4's commit. Gate:
`bash scripts/e6-gate.sh` (`npm run e6`); the scenario on its own is
`npm run e6:scenario`._

## Verdict

**The work order's gate is met**, and it is met by a bridge nobody here wrote:

| what the work order asked for | outcome |
|---|---|
| a bridge inside Blender pointed at the gate instead of at ComfyUI | **PASS** — `alexisrolland/ComfyUI-Blender` **v3.3.4**, the project's own release zip (sha256 `a1492de6…`), unmodified. One string in its own `AddonPreferences`. |
| the user generates | **PASS** — its own `bpy.ops.comfy.run_workflow`, its own `/ws`, its own `download_file`. This repository makes no HTTP request in the whole run. |
| ONE leaf carrying the workflow graph… | **PASS** — `workflow_hash`, and it is proved to be *the body the bridge sent* by recomputing it from the bridge's own `client_id` with the SDK's `hashWorkflow` |
| …`model_fingerprints` computed from the model files… | **PASS** — `c6c3638ac614…` over `upscale_models/scruple-tiny-x2.safetensors`, hashed by the desktop from the file ComfyUI loaded |
| …AND `host_semantics: supplied` with the scene facts | **PASS** — `blender` / `comfy-bridge@0.1.0`, scene, frame, camera, engine, resolution, samples, format |
| re-hash the artifact from the bytes on disk and read the leaf out of sqlite, from the shell, outside node | **PASS** — `scripts/e6-gate.sh` stage 4 is `sha256sum` and `sqlite3` and nothing else |
| control (a) `model-swap` moves the fingerprint and nothing else | **PASS** — one assertion red, exactly |
| control (b) the bridge pointed **around** the gate still leaves a witnessed artifact, `no-graph` and `blind` | **PASS on the substance, and the work order's word is wrong**: the artifact is witnessed, the leaf carries no graph and no fingerprints — and it reads **`declined`, not `blind`**, because the addon is registered. Finding **E6-5**. |
| control (c) an announcement naming a scene no generation produced must not make a leaf claim it | **PASS** — asked of the whole `iterations` table, and made demonstrable by a mutation that changes only the id |

The leaf, read with `sqlite3` from bash:

```
               id = 679                         (and 680 — one generation, two leaves)
        leaf_kind = workflow
    workflow_hash = bbe96698bc11a1f3…           the graph the BRIDGE POSTed
 model_fingerp…sh = c6c3638ac614c580…           the weights the DESKTOP hashed
             host = blender
     host_adapter = comfy-bridge@0.1.0
   host_semantics = supplied
attestation_basis = stale                       🔴 never `verified`

{"camera":"CAM_hero","engine":"BLENDER_EEVEE_NEXT","file_format":"PNG",
 "frame":173,"material_count":2,"object_count":3,"resolution":[1920,1080],
 "resolution_percentage":100,"samples":64,"scene":"atrium-c1a4935d853fa490…"}
```

The bridge was pointed at `http://127.0.0.1:39589` — the port the kernel gave
the gate when it bound 0, seconds earlier. Nothing in this repository could have
written that string in advance, and the assertion compares it against the gate's
own ready file rather than against a constant.

---

## Which bridge, and why — the flagged question

⚑ *"If a bridge cannot be pointed at an arbitrary address, that is a finding
about that bridge — name it, pick another, and say which of the eleven you
tried. Do not fork one, vendor one, or patch one."*

**Tried and used: `alexisrolland/ComfyUI-Blender` v3.3.4** (188 stars, second by
adoption). Architecture B in the research doc — a client with no embedded
server, an API-format workflow and a `server_address` string in its own
preferences. It can be pointed at an arbitrary address, it was, and nothing
about it was changed: `scripts/e6-install-bridge.sh` downloads the release asset
and pins its digest, and clones the repository at the same tag for the ComfyUI
half its README says to install. `.run/e6/bridges/INSTALLED.json` records what
landed.

**Considered and not used**, with the reason in each case — none of these is a
finding against the bridge, they are properties of this box:

| bridge | why not |
|---|---|
| `AIGODLIKE/ComfyUI-BlenderAI-node` (1,500★) | the market leader, and the closest second choice. It converts the ComfyUI graph into Blender's node editor, so driving it headless means building a node tree rather than importing an API JSON — a much larger surface for the same claim, and it bundles/launches its own ComfyUI, which is the arrangement this work order is trying *not* to use. |
| `tin2tin/Pallaidium` (1,300★) | requires **Blender 5.2+**. This box's newest Blender is 4.2.23 (WO-E3: blender.org publishes no Linux ARM64 build at all). |
| `sakalond/StableGen` (816★) | builds its own workflows around SDXL/FLUX checkpoints. Nothing here has those weights, and a fabricated substitute would make the model-fingerprint control meaningless. |
| `carson-katri/dream-textures` | does not use ComfyUI. In the survey for completeness only. |
| `miguelmarco/comfyui_blender_material`, `LatentSpaceDirective/ComfyUI-Texturaizer`, `IANMRU/PallaidiumAI`, `gameltb/io_comfy`, `a-One-Fan/…-node-editor`, `RobeSantoro/AI-Render-ComfyUI-Support` | implicit workflows around real checkpoints, or forks of the two above, or unmaintained. Same objection as StableGen, or same as AIGODLIKE. |

**Every one of the eleven configures a ComfyUI address**, which is the sentence
`docs/BLENDER.md` rests on, and it is now measured on one of them rather than
read off eleven READMEs.

---

## What was built, and what deliberately was not

| file | what |
|---|---|
| `app/ipc-blender-generate.js` | `scruple:blender-generate`. **Launches a Blender and waits for a file.** It makes no request to the gate, to ComfyUI or to anything else. |
| `app/preload.js`, `app/main-modular.js` | one channel, registered and reaped |
| `scripts/e6-blender-generate.py` | runs inside Blender: set the address, import the workflow through the bridge's **own** operator, press Generate, announce, wait for the download, report JSON |
| `scripts/e6-install-bridge.sh` | fetches the bridge, digest-pinned. Not a fork, not vendored, not patched. |
| `scripts/e6-workflow-hash.ts` | `hashWorkflow` from the SDK, so the driver never grows a second canonicalizer |
| `scenarios/blender-generate.json` | 36 assertions, four mutations |
| `scripts/e6-gate.sh` | the gate, including the shell stage |
| `scripts/desktop-run.mjs` | the `blender-bridge` fixture, `customNodes` on the model store, three assertion kinds, three mutations, and the pre-run `iterations` watermark |

**`app/comfy/` is unchanged** — the gate, the host adapter, the model sink and
the SDK vendoring are byte-identical to WO-E4's commit. `HOST-HOOK.md` says
"there is no step 4"; a real third-party bridge arriving needed no step 4 either.

### Three decisions worth reading

**1. The app launches Blender; it does not generate through it.** The obvious
shortcut was to have the handler POST the workflow itself and call the Blender
part decoration. That would have satisfied every assertion in
`scenarios/blender-host.json` and none of this work order: the whole claim is
that the request is the bridge's. So the handler spawns a process and polls a
directory, and the only thing it does with the result is hash it.

**2. The renderer may choose the workflow and the scene, and may NOT choose the
address.** `ipc-comfy.js`'s rule, unchanged. A page that could name the target
could point the bridge past the gate and then report that it had not — which is
exactly the mutation `bridge-around-the-gate` performs, from the environment.

**3. The phantom announcement runs on every clean run, not under a mutation.**
Control (c) asks that an announcement naming a scene no generation produced must
not reach a leaf. An absence that is only checked when a mutation creates it is
weaker than one checked always, so every run writes a second, schema-valid
announcement of a real scene under an id nothing was submitted with, and asserts
that **no row in the whole `iterations` table** mentions it. The mutation
`announce-the-phantom-under-the-real-id` then changes exactly one thing — the id
— and the same document lands on the leaf. The id is what kept it off.

---

## Findings

### ⚑ E6-1 — this bridge does not send a `prompt_id`, so the announcement is a race

`HOST-HOOK.md` says: *"a Level-2 host mints an id, writes `announce/<id>.json`,
and POSTs `/prompt` with that id"*, and WO-E4 built the whole correlation on
that being possible. **It is not possible with this bridge.** `run_workflow.py`
posts

```py
data = {"client_id": addon_prefs.client_id,
        "extra_data": {"api_key_comfy_org": addon_prefs.api_key},
        "prompt": workflow}
```

— no `prompt_id`. ComfyUI mints one, the bridge reads it off the response, and
the earliest moment any host can know it is **after** the POST has returned. The
announcement therefore cannot precede the submission, and the window it has is
however long the generation takes:

```
   submit → response          0.233 s
   announce                   0.024 s
   ⚑ margin to the download   1.804 s
```

Measured on a 32×32 image through a 7 KB upscaler, which is close to the
smallest generation that can exist. **A generation faster than the announcement
would produce a leaf reading `declined`.** Nothing is unsound — a late
announcement makes a leaf say *less*, never something false, which is the
property WO-D6 designed for — but the sequence `HOST-HOOK.md` describes is not
one every bridge can perform. `docs/HOST-HOOK.md` limit 3 now says so.

⚑ **And a second half of the same finding: an unmodified bridge does not call
`bpy.ops.scruple.host_announce`.** In this run the caller was
`scripts/e6-blender-generate.py` — the eleven lines that stand in for a user's
hand. In a shipped product that caller has to be something: a Scruple panel
button the user presses instead of the bridge's, an operator wrapper, or a
per-bridge integration. What it must **not** be is a patch to the bridge. This
is the largest piece of unfinished product design in the E series and it is
named here rather than left to be discovered.

### ⚑ E6-2 — the bridge is running below its own declared minimum, and Blender does not care

`comfyui_blender` v3.3.4 declares `"blender": (4, 5, 0)` in `bl_info` (HEAD
declares `(5, 0, 0)`; **no release of this bridge declares support for 4.2**).
It was installed into Blender **4.2.23** and enabled without raising, all 40 of
its operators registered, and it worked. This is WO-E3's finding **E3-1** —
*"on the legacy path the declared minimum is advisory: shown in the preferences
UI and enforced by nothing"* — observed on a third party's addon rather than on
ours, which makes it a property of Blender rather than of our packaging.

Two consequences, and the second is the one that matters here:

1. Everything E6 measured about this bridge was measured on an unsupported
   combination. It behaved correctly, and that is luck rather than a guarantee.
2. ⚑ **A Blender user can enable an addon their Blender is too old for and get
   no warning.** The Scruple addon is version-gated on 4.2+ because it ships a
   `blender_manifest.toml`; this bridge is not, because it does not.

The fix on our side is not available — we do not patch the bridge — so what E6
does instead is **record which Blender the measurement was taken on, on the
leaf**: `hostVersion` in the declaration is `bpy.app.version` from the process
that declared. A leaf from this run says `blender@4.2.23`.

### E6-3 — `--factory-startup` silently un-enables everything else in the profile

Found by failing: the fixture installed the bridge with
`blender --background --factory-startup --python-expr '… save_userpref()'`, and
the resulting preferences file had **only** the bridge in it. The Scruple
extension, installed into the same profile a moment earlier, was gone — so the
declaration was never written and the gate came up at Level 1. `save_userpref()`
from a factory start writes the factory state plus whatever the script did, not
a merge. Fixed in `materialiseBlenderBridge`, with the reason at the call site,
because the next person to add an addon to a profile will reach for the same
flag.

### ⚑ E6-5 — the bypassed leaf is `declined`, not `blind`, and the work order said `blind`

WO-E6's control (b) asks that a bridge pointed around the gate "must still leave
a witnessed artifact via the output watcher, recorded `no-graph` and `blind`, per
finding D4-2". Measured, with the bridge's `server_address` set to ComfyUI:

```
               id = …          leaf_kind = workflow
    workflow_hash = (null)     ← no graph. The gate never saw a POST /prompt.
 model_fingerp…sh = (null)     ← no fingerprints. The adapter never saw a graph.
             host = blender    ← ⚑ STILL NAMED
     host_adapter = comfy-bridge@0.1.0
   host_semantics = declined   ← ⚑ NOT `blind`
```

`blind` was right for WO-D4 because **nobody was registered** then. Here the
addon is registered, the declaration is on disk and the gate came up at Level 2;
what happened is that the watcher's observation has no prompt to correlate to,
so `semanticsFor` returns nothing and the SDK records `declined`. That is the
distinction `HOST-HOOK.md` exists to hold open, arriving in a case nobody
designed it for:

- `blind` → nobody to ask. Install an adapter.
- `declined` → there **is** an adapter, and it had nothing to say about this
  artifact. Which, for an artifact that came in around the gate, is precisely
  true and precisely useful: **an operator reading that leaf learns both that a
  Level-2 deployment exists and that this artifact did not go through it.**

Two assertions therefore stay GREEN under `bridge-around-the-gate` —
`leaf-names-the-host` and `leaf-names-the-adapter-and-its-version` — and the
audit sweep declares them green rather than red. The gate asserts `declined`
as measured, with the work order's `blind` recorded here rather than quietly
satisfied.

### E6-4 — one generation, two leaves, and both carry all three halves

`witnesses` holds two rows for the artifact (`1020`, `1021`) and `iterations`
two (`679`, `680`): the gate sees the bytes twice — once as the `/view` response
the bridge downloaded, once as the file the output-volume watcher found — and
emits a leaf for each. Both are correlated to the same prompt, so both carry the
graph, the fingerprints and the scene. This is WO-D7's "count leaves, not
artifacts" arriving in a place where it could have been mistaken for double
counting. It is not a defect; it is the two-surface claim (H-4 §2) being true.

---

## What this does NOT cover

- **Nothing was rendered.** Blender ran headless and produced no pixels: the
  scene facts describe the scene the generation was *launched from*, not a
  render. WO-E4's finding E4-5 is unchanged — the announcement is bound to the
  artifact by the prompt id and by nothing else, and no cross-check exists that
  the announced scene is the scene anything was made from. Control (c) is the
  strongest available statement and it is about the **id**.
- **One bridge, one version, one workflow shape.** `BlenderOutputSaveImage` is
  the only output node exercised; the 3D/GLB and text output paths, the input
  nodes (seed, sampler, checkpoint, LoRA, image upload) and the `/upload/image`
  route through the gate are all untouched.
- ⚑ **The `/ws` went through the gate and nothing asserts what the gate did with
  it.** The bridge's WebSocket carried the `executed` message that triggered the
  download, so the gate's WS surface was in the path — but this work order
  asserts only that the connection was established and that the bytes arrived.
- **The bridge's ComfyUI half is installed by symlink into a per-run base
  directory.** That is the documented installation (`git clone` into
  `custom_nodes`), and `--base-directory` is what makes it per-run; it is not
  how a user's machine is laid out.
- **Every Blender measurement is on an emulated CPU** (finding E3-2, aarch64
  under `qemu-user`).
- 🔴 **Every leaf here reads `attestation_basis: stale`** and is asserted to.
  The surrogate is SOFTWARE-backed and the profile is `desktop`; `verified` is
  unrepresentable by construction (migration 053) and nothing here went near it.
