# Stooges brief — the Blender + ComfyUI wrap

_2026-09-08. A prompt for a Stooges deliberation. Everything stated as fact
here was measured on 2026-09-07, not inferred._

---

## Paste-in prompt

> **You cannot read our repository.** Everything you need is stated below;
> the file paths are pointers for the human, not for you. If you find
> yourself needing the contents of a file to answer, say so explicitly
> rather than inventing it.

We are deciding how to capture provenance for **Blender** users who generate
with **ComfyUI**. Two forces pull against each other and we want the best
point on that curve, not a wish for both ends:

- **Minimal user friction** — people already have Blender, already have
  ComfyUI, already have add-ons they like. Anything that makes them install
  a different Blender, re-download models, or change how they work will not
  be adopted.
- **Minimal attack surface for bait-and-switch** — a user must not be able
  to substitute inputs or outputs and have our record vouch for the swap.
  A provenance system that can be gamed casually is worse than none: it
  launders a lie into evidence.

### What already exists — and works

**Scruple Desktop Studio already does this for ComfyUI and Kohya.** The
mechanism is a **sidecar gate**: a standalone HTTP component that sits in
front of exactly one ComfyUI, takes a single upstream URL, and refuses to
start without it. It classifies traffic by route — it already discriminates
ComfyUI's `prompt` / `api/prompt` and `view` / `api/view`. Everything a
ComfyUI generation does crosses it. This is proven, in production shape, and
is the vendor-integration pattern our standard is built around.

**The Blender add-on was brought to the L2 floor overnight on 2026-09-07.**
It now witnesses through our `/v2` surface, produces leaves whose signatures
verify independently against the signer's public key, produces **C2PA
credentials that the `c2pa` library reads as Valid** (and reads a tampered
copy as Invalid), does store-and-forward with real gap detection (a
deliberately dropped capture is reported missing, not silently absent), and
has a six-panel project/tracker/lock dashboard. 308 tests. Every claim has a
control that was demonstrated failing.

### The problem, stated precisely

Our own conformance grader **degrades the Blender add-on from
`attested-client` to `unattested-client`**, `enforcement: none`,
`honoured: false`. That is not a bug. Placement in our model is a lattice
and **must be EARNED, never self-declared**:

| placement | enforcement it requires |
|---|---|
| `server-library` | no tenant code |
| `sidecar-gate` | isolated namespace |
| `attested-client` | host-enforced signature |
| `unattested-client` | none |

An add-on living inside a Blender we do not control, with its key in a
user-writable Python file, earns the bottom rung. **No amount of better
capture changes that.** More coverage at `enforcement: none` is still
`enforcement: none`.

### What the market actually does

Eleven Blender↔ComfyUI bridges exist. **All of them speak plain HTTP
`/prompt` plus a websocket** — the exact surface our gate already
classifies. Usage is **overwhelmingly local**: artists run ComfyUI on their
own GPU, and nobody has native cloud integration (remote use is manual
URL-pasting).

The leader is **ComfyUI-BlenderAI-node** (AIGODLIKE, ~1,500 stars,
**GPL-3.0**, actively maintained). Despite the name it is a **Blender
add-on, not a ComfyUI custom node** — it installs into Blender and
*launches or connects to* a separate ComfyUI process. It is not a thin
relay: it translates ComfyUI's node graph into Blender nodes, imports
generated meshes into the viewport, and — critically — **its inputs are
often Blender-side data that never exists as a file** (the viewport, a
render, the camera, grease-pencil and object-projection masks), while its
outputs can **replace an existing image datablock in place**.

That produces the central asymmetry:

> **The gate has the bits. The add-on has the meaning.**
> A sidecar sees an anonymous PNG being uploaded. It cannot know that PNG
> was "the viewport of scene X at frame Y through camera Z." Neither half
> alone makes a complete leaf.

### The threat model to reason about

Assume a user who wants a Scruple record to say something false, and who
owns the machine. At least these moves exist:

1. Generate with AI outside the gate, then witness the result as hand-made.
2. Point the add-on straight at ComfyUI, bypassing our gate, then present
   the output as gated.
3. Swap the bytes on disk between generation and witnessing.
4. Replace the image datablock after generation and before save.
5. Run a second, unmonitored ComfyUI.
6. Edit the add-on — it is Python, and user-writable.
7. Present a downloaded AI image as a viewport render.

Note that **we cannot ever prove an input's origin on a machine we do not
own.** We can only chain it (if it arrives carrying its own credential) or
mark it undeclared. Proposals that quietly assume otherwise are wrong.

### The candidate designs

- **A — thin redirect.** Ship almost nothing; the user points their existing
  add-on's ComfyUI address at our local gate. Near-zero friction. Earns
  `unattested-client`; defeated by moves 2, 3, 5, 6.
- **B — fork the add-on.** Fork AIGODLIKE (GPL permits it) to add semantic
  hooks, so we know a given upload was the viewport rather than an anonymous
  file. Buys meaning. Inherits permanent fork maintenance against a
  fast-moving upstream. Still a user-writable add-on.
- **C — Electron wrapper owning both launches.** We spawn ComfyUI (bound to
  a port we choose) and Blender (with the add-on preconfigured to address
  our gate), holding custody keys in a hardware-backed keystore. Highest
  friction; the only design that can plausibly earn a rung above the bottom.
- **D — upstream a hook.** Get a provenance callback into AIGODLIKE itself.
  No fork, no install weight, but depends on someone else's cooperation and
  makes us a public dependency.

⚑ One constraint discovered: **ComfyUI embeds in an Electron tab trivially
(it is a web app — our earlier Electron build used webviews heavily), but
Blender cannot.** It is a native OpenGL application with no web or remote UI
mode at all. So "both in tabs" is not available; the wrapper can own both
*launches* and the *path between them*, which is what containment actually
requires, but Blender will be its own OS window.

⚑ A second constraint: a Blender add-on that imports `bpy` is generally
required to be **GPL-compatible**. Our add-on currently declares
`SPDX:LicenseRef-Proprietary` and has our SDK vendored inside it. This is a
question for a lawyer, not for you — but note that designs which keep the
proprietary machinery behind a process boundary (the gate) and leave the
add-on thin and open resolve it structurally.

### What we want from you

1. **Rank the four designs** against the two forces — friction and
   bait-and-switch resistance. Say which you would ship first and why.
   Do not answer "a combination" without saying what ships in v1.
2. **Attack your own recommendation.** For each of the seven moves above,
   say whether your design detects it, prevents it, or is blind to it.
   Being blind is acceptable if it is *declared*; being blind while the
   record implies otherwise is not.
3. **Answer the open canon question:** `sidecar-gate` requires an *isolated
   namespace*. On a desktop the user is root. Is there a concrete mechanism
   by which a desktop wrapper earns that — a container runtime, a signed and
   notarised bundle, an OS sandbox — or should our canon state plainly that
   a desktop wrap tops out below the sidecar rung no matter how good its
   capture is? A clear "it cannot be earned, say so in the standard" is a
   valid and useful answer.
4. **Name what you would refuse to claim.** Which leaves produced by your
   design must say "undeclared" rather than assert a source?

Disagree with each other explicitly where you disagree. We would rather have
a live dissent recorded than a consensus that papers over the hard part.

---

## Code and document references (for the human, not the models)

Nothing below is pushed to a remote; these are paths on the Scruple host.

**The lattice and the floor** — `/data/scruple-web/`
- `packages/scruple-api/scruple_api/surface.py` — Placement, PlacementEnforcement, `_REQUIRED_ENFORCEMENT`, the ObservationSink Protocol. **The single most relevant file.**
- `docs/canon/PLACEMENT_AND_SURFACES.md`, `CAPABILITY_CLASSES.md`, `CUSTODY_LOCUS.md` — the three axes
- `docs/canon/L2_FLOOR.md` — what L2 requires of every path
- `docs/canon/L2_AS_THE_VENDOR_FLOOR.md` — the banking mapping; settles client-binding, makes H-4 mandatory
- `docs/canon/CANON_SKELETON.md` — §5 forbids an adapter assembling its own envelope
- `docs/canon/INTEGRATION_LIFECYCLE.md` — integrate, test, *then* seal
- `docs/canon/STUDIO_IS_AN_EXEMPLAR.md` — "not most capable, most faithful"

**The gate that already captures ComfyUI**
- `services/scruple-capture/src/component.ts` — the standalone sidecar (its own server)
- `services/scruple-capture/src/config.ts` — `SCRUPLE_CAPTURE_UPSTREAM_URL`, single upstream
- `lib/canvas/egress.ts` — route classification, `prompt` / `view`; note the C-8 comment on nodes that touch neither
- `lib/canvas/gate.ts` — why Canvas is a *different* consumer of the same component
- `lib/apps/registry.ts` — the app registry; `backend: 'local' | 'modal' | 'runpod'`, Fusion is already `local`

**The Blender work** — `/data/scruple-blender/`
- `docs/canon/blender-l2/STATE.md` — read first; what is proven, what is not
- `docs/canon/blender-l2/01-GAP.md` + `gap.json` — the measured gap, machine-readable
- `docs/canon/blender-l2/08-AI-IN-BLENDER.md` — how AI is really used in Blender; 4 of 7 categories invisible
- `docs/canon/blender-l2/09-BLENDER-COMFYUI-RUNTIME.md` — the 11 bridges, where ComfyUI runs
- `adapter/scene.py` — MIME declared never guessed; the format tables
- `adapter/handlers.py` — the capture triggers

**Disclosure and custody**
- `app/api/v2/receipt/[leaf_id]/route.ts` + `lib/db/migrations/052_leaf_signature_disclosure.sql` — the receipt now discloses signature, signer, surrogate flag and canonicalization profile, so a third party can verify

**Prior art on this box**
- `research/electron-source/` — the earlier Electron app that wrapped ComfyUI (84 JS files; webviews for the web app, IPC + lock executors)

**External**
- https://github.com/AIGODLIKE/ComfyUI-BlenderAI-node — GPL-3.0, the bridge to fork or redirect
