# WO-G4 — the Blender tab

_2026-09-10. Gate: `bash scripts/g4-gate.sh` — **14/14**. `scripts/g1-gate.sh`
re-run and green after its declared sets were updated._

Blender sits beside ComfyUI and Kohya_ss: a view-toggle button, a container, and
the same enabled-gating. Nothing about the other tabs moved.

## The one difference from the existing pattern

**ComfyUI and Kohya_ss are web applications.** Their tabs are `<webview>`
elements pointed at `127.0.0.1:8188` and `:7860`, with a `.webview-overlay`
covering the frame when the app is not answering.

**Blender is a native application.** There is no URL to embed and no headless
mode that would put a viewport in a browser frame. So the Blender container is
**the overlay without the webview**: the same `webview-overlay`,
`overlay-content`, `status-icon` and `retry-btn` classes — because the user
already knows that shape and a new one would be new friction for no new
understanding — with a state panel where the embedded page would be.

That difference is **forced by what Blender is, not chosen**, and the gate
asserts it in both directions: the overlay classes must be present, and
`.blender-container webview` must have **no node**. A `<webview>` in this tab
would mean someone had pointed it at something that is not Blender.

## Two readings, two costs, deliberately not collapsed

| Question | How | Cost | Decides |
|---|---|---|---|
| Is there a Blender? | `scruple.profile()` → `fs.existsSync` | instant | whether the **tab exists** |
| What is in it? | `scruple.blender()` → starts a headless Blender | **~30 s** on aarch64 under qemu (finding E3-2) | what the **panel says** |

Putting the second behind the first would make every render of every tab wait for
a Blender, and a machine whose Blender hangs would take the window with it.
`app/main-modular.js` made the same split for the same reason at WO-E5.

So measuring is **a button**, not something that happens on open — and until it
is pressed the panel says *"Blender Not Measured"*. 🔴 **A panel that filled in a
plausible version number would pass every assertion anyone would think to write,
and be a lie.** The gate asserts the words are there.

## What the gate proves

Two boots, because one process cannot both have a Blender and not have one.

- **Absent, not greyed.** With the binary taken away there is no tab node, no
  container, and the strings `data-view="blender"` and `blender-container` do not
  appear **anywhere in the serialised document** — which is a stronger question
  than "is there a node", because it catches a tab rendered hidden or disabled.
- **The other tabs are unchanged, asserted by diff, not by eye.** The tab set
  with Blender minus the tab set without it is `{"added":["Blender"],"removed":[]}`.
  Exactly one thing appeared. *"The other tabs look fine"* is how a missing tab
  survived seven work orders.
- The ComfyUI container, the project sidebar and the absence of any `[data-region]`
  hold in **both** runs.

## ⚑ The G1 gate caught this change, and that is the point

Adding the tab turned `scripts/g1-gate.sh` red on all three of its boots:
`got [Blender,ComfyUI,Fiat,Workspace] expected [ComfyUI,Fiat,Workspace]`.

That is the gate working. It compares a **set**, not a list of presences, so a tab
nobody declared cannot slip in. Its three expectations were updated **in the same
commit as the change, with the reason written above them** — which is the
difference between a change and a drift, and the difference D5 did not have.

## Not claimed

Nobody has clicked the tab. The panel renders, the button exists, and the
measurement path behind it is WO-E5's, already proven. Whether the panel *reads
well* to a person is G3's question.

The panel says plainly when no capture gate is running: **work done in that
Blender is not witnessed.** The tab shows what is there; it does not claim what
is not. Witnessing the objects that cross from ComfyUI into Blender is WO-G7.
