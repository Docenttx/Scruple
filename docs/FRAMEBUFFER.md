# `docs/DESIGN.md`'s blank-screenshot claim is unsupported, and wrong three different ways

_2026-09-10, build box. Prompted by the travel laptop's W1-0._

## The claim

`docs/DESIGN.md:83-85`:

> ⚑ **A screenshot will be blank.** llvmpipe's framebuffer readback returns a
> uniform image — three approaches were tried against Blender and a detector
> proven on real renders. Do not gate anything on pixels.

🔴 **The cited detector is in no tree**, was never committed to `scruple-desktop`,
`scruple-web` or `scruple-blender`, and left no scratch survivor; the Blender
canon docs never mention it. The claim cites evidence that does not exist in any
retained form — and that sentence was propagated verbatim into every work-order
prompt in the D and E series, which is why both were written never to touch
pixels.

## What is actually true, measured with a detector that has controls

A detector was built on the laptop's W1-0 pattern: five controls (uniform grey,
uniform black, gradient, noise), **no verdict issued unless all pass**.

| what | result |
|---|---|
| **Electron `capturePage` under xvfb / llvmpipe** | 🔴 **NON-BLANK.** Real content stddev **51.15**, 441 colours; the uniform control came back BLANK (stddev 0, 1 colour) in the same run. **VERDICT: framebuffer is live.** |
| **Blender 4.2.23 x64 (vendored) under qemu, `bpy.ops.render.opengl`** | **SIGSEGV.** Dies inside `libLLVM-15`'s `GenericScheduler` — llvmpipe JIT-compiling shaders under emulation. Crashed, not blank. |
| **Blender 3.0.1 native aarch64, `-b`, same call** | **REFUSED**: `Cannot use OpenGL render in background mode (no opengl context)`. Refused, not blank. |

⚑ **Blank, crashed and refused are three different failures with three different
fixes**, and the doc collapsed all of them into the one that happens to justify
"never gate on pixels".

## The honest limit of this test

All three Blender attempts used **background mode** (`-b`). A GUI-mode Blender
with a real window under xvfb was not tested, and that is plausibly where the
original observation came from. So the correct replacement sentence is not "a
screenshot will NOT be blank" — swapping one unmeasured claim for another is the
same defect. It is: **Electron capture is live and measurable here; Blender's GL
readback path could not be made to produce an image at all on this box, by two
different routes, for two different reasons.**

## What follows

1. **Promote the laptop's detector to the shared tree** and score against it,
   never against a remembered result.
2. **Rewrite DESIGN.md** to say the three measured outcomes and mark the GUI-mode
   case as untested rather than assumed.
3. **`npm run gate` on the laptop may legitimately screenshot.** The rule "never
   gate on pixels" survives for a different and better reason — a pixel
   comparison across platforms is meaningless when captures are PHYSICAL pixels
   and the laptop's scale factor is 1.29 (its own finding) — not because captures
   are blank.
