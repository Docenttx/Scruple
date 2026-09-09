# Scruple Desktop Studio — design

_2026-09-09. Forked from `scruple-web/research/electron-source` at `0be2a2b`.
Recon: `scruple-web/docs/canon/DESKTOP_STUDIO_RECON.md`._

## What this is

**A local agent with a dashboard — not a standalone application.**

It owns the things that genuinely require being on the user's machine, and it is
honest about being useless without the server rather than claiming a
self-sufficiency it cannot back:

- it **launches** ComfyUI, Kohya and (later) Blender, so it knows the binary,
  the version and the model directory
- it puts the **capture gate in the path** between those apps and ComfyUI
- it hashes a **vault** — a directory of files at a moment — which a server-side
  gate structurally cannot do, because a gate observes a wire and never sees a
  directory
- it computes **model fingerprints** from the local model store, which is the
  only way to answer *"was a proprietary LoRA used"* rather than *"a file with
  that name was referenced"*

Everything requiring a signature — C2PA credentials, H-1 leaf signatures —
happens on the server. The key is deliberately somewhere the desktop cannot
reach; that is the custody claim, not a limitation to engineer around.

## Decisions already settled — do not re-litigate

**One UI, served.** The dashboard is one Next application. Web Studio serves it
directly; Desktop Studio hosts the same routes in a `BrowserWindow`. The pattern
is already proven on a real install by `app/embed/fusion/page.tsx`, a Next route
designed to be mounted by a desktop host with a host↔page bridge. Electron is
the same shape with a preload script in place of `sendInfoToHTML`.

**Capability, not code, is what differs.** `GET /api/v2/capabilities` was built
for this: *"applicability is not secret, and a client should be able to render
its UI before the user has signed in."* Desktop reports local ComfyUI/Kohya, the
vault and the wallet; web reports Modal and RunPod. Same components.

**Not bundled.** Electron points at the served UI. No local Next server, no
version-skew discipline between a bundled UI and the server API.

**No offline mode.** Both signatures require the network by design. An offline
attestation would need its own standard, signed by something on the user's
machine — beneath a tier already the weakest we offer. 🔴 This is NOT a reason
to delete the queue: store-and-forward is fault tolerance for a slow, saturated
or restarting witness with the user fully online.

**The UI is canon.** ~2,951 lines of CSS carrying 21 design tokens, which Web
Studio was cloned from and then drifted away from — the two share **zero**
tokens today. The canon design is ported **into** the shared theme once. After
that there is one implementation and nothing to diverge.

## Architecture

    ┌─ Electron main ────────────────────────────────────────┐
    │  launches + measures:  ComfyUI · Kohya · Blender        │
    │  owns:                 vault dir · model store paths     │
    │  runs:                 the capture gate (sidecar)        │
    │  preload bridge:       window.scruple.*  (IPC)           │
    │                                                          │
    │  ┌─ BrowserWindow ─────────────────────────────────┐    │
    │  │  the SAME Next UI Web Studio serves              │    │
    │  │  renders from GET /api/v2/capabilities           │    │
    │  └──────────────────────────────────────────────────┘    │
    └──────────────────────┬───────────────────────────────────┘
                           │  /api/v2/witness · receipt · resolve
                           ▼
              scruple-web  →  witness  →  signer (KMS / surrogate)

The legacy `ipc/` handlers — lock, project, settings, training, wallet — are the
seam the preload bridge exposes. They exist; they are pre-v1 and must be
rewritten onto the SDK, but the shape is right.

## Proving it on a server, with no screen

Electron **is not installed on this box** and there is no display. Both are
solved by patterns already proven here:

- **xvfb** runs a real GUI headlessly — verified for Blender 3.0.1 (`xvfb-run -a
  -s "-screen 0 1280x900x24"`, real GL via llvmpipe). Electron runs the same way.
- ⚑ **A screenshot will be blank.** llvmpipe's framebuffer readback returns a
  uniform image — three approaches were tried against Blender and a detector
  proven on real renders. Do not gate anything on pixels.
- **`scruple-web/scripts/scruple-run.ts`** is the headless wrapper for Web
  Studio: *"runs a workflow through the real `/api/runs` endpoint — the same path
  a user hits — without the canvas."* Desktop needs its mirror: a
  `scripts/desktop-run.mjs` that launches the real Electron app under xvfb,
  drives a scenario through the **real IPC handlers**, and asserts **by side
  effect** — rows in the witness, bytes on disk that re-hash to the recorded
  content hash.

That is the overnight proving loop: no human, no screen, real code paths.

## The ComfyUI hook — generic, not Blender-specific

Blender is the first consumer of this hook, not a special case. Any host with a
ComfyUI bridge plugs in at two levels:

**Level 1 — point its ComfyUI address at our gate.** Costs the host nothing and
requires no code from us. Captures the workflow, the uploads and the outputs,
because every bridge speaks plain HTTP `/prompt` plus a websocket. Produces an
honest but *semantically blind* record: an anonymous PNG was uploaded.

**Level 2 — register a host adapter.** A capture surface implementing the
`ObservationSink` contract in `packages/scruple-api/scruple_api/surface.py`,
which is described in its own header as *"the interface a vendor implements for a
host we have not met."* The adapter supplies the meaning the gate cannot see —
that this upload was the viewport of scene X at frame Y through camera Z.

So the hook is: **the gate is host-agnostic; the meaning is host-supplied.**
Adding Photoshop, ToonBoom or Meshroom later is a Level-2 adapter, not a new
capture path. The gate never changes.

⚑ **Built by WO-D6, and specified in `HOST-HOOK.md`.** One thing that section
did not say and the implementation had to settle: the level is on the leaf, and
**Level 1 declares itself**. `capture.host_semantics` is three-valued — `blind`,
`declined`, `supplied` — never null on a component leaf, and inside the MAC. A
Level-1 leaf is not a Level-2 leaf minus some fields; it says it had nobody to
ask. And `declined` is a third value rather than a shade of `blind` because "an
integration that is not working" and "an integration that was never done" have
different fixes.

## What is kept, what is replaced

| kept | replaced |
|---|---|
| the UI design — 21 tokens, `main.css`, the workspace/wallet layouts | its implementation, which moves into the shared Next app |
| the **vault model** in `lock/lock-local-lock.js` — a set of files at a moment | its hashing: extension-branching → declared MIME, unbounded `readFileSync` → a ceiling with a refusal outcome |
| the `ipc/` seam — lock, project, settings, training, wallet | the handlers themselves, onto the SDK and `/api/v2/*` |
| — | `lock/merkle.js`: the sorted-pair construction, retired by the WO-C6 cutover. It cannot bind an index. |
| — | the v0 routes: `/api/fiat-chain-lock`, `/api/testnet-lock`, `/api/v0/add` |

⚑ The wallet — 21 files touching private keys, mnemonics and WIF — gets its own
security review **before** any of it is revived. An Electron app holding spending
keys is a different posture from a gate holding a signing key, and it should not
be inherited simply because it was already in the box.
