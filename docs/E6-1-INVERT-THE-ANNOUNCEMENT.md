# E6-1 — Level 2 without touching the bridge: invert the announcement

_Design proposal, 2026-09-10. Addresses WO-E6's finding E6-1, which its own
report calls "the largest unfinished product design in the series."_

## The problem, as measured

`HOST-HOOK.md` specifies that a Level-2 host **mints a correlation id and
announces BEFORE submitting**. WO-E6 put a real unmodified third-party bridge
(`alexisrolland/ComfyUI-Blender v3.3.4`) through the gate and found the
specification cannot be satisfied:

1. 🔴 **The bridge sends no `prompt_id`.** ComfyUI mints it and returns it, so
   **the id does not exist until after `/prompt` answers** — measured margin
   **1.8s** in which the artifact is already in flight and nothing can be
   correlated to it.
2. 🔴 **An unmodified bridge never calls `bpy.ops.scruple.host_announce`.** In
   E6 the caller was a script standing in for the user's hand.

So Level 2 today requires either a forked bridge or a human pressing something —
and `BLENDER.md` says explicitly that we do not fork bridges.

## The fact that makes this solvable

**The gate already knows the `prompt_id` before the client does.**
`services/scruple-capture/src/surfaces/http-gate.ts:227-234`:

```ts
if (isPrompt && upstreamRes.status < 400) {
  const out = JSON.parse(upstreamRes.body.toString('utf8')) as { prompt_id?: string };
  if (out.prompt_id) { const rec = this.opts.correlator.openPrompt(out.prompt_id, graph); ... }
```

`/prompt` is one of the routes the gate **buffers rather than streams** — a
decision made for the ratchet, since "the client must not hold a byte before the
counter is spent". A consequence nobody was looking for: the gate holds
ComfyUI's response, and therefore the id, *before the bridge is given it*.

## The proposal: the gate ASKS, the host does not announce

Invert the direction. Instead of host → gate ("here is what I am about to do"),
gate → host ("prompt X was just accepted; do you have semantics for it?").

    bridge --POST /prompt--> [gate] --> ComfyUI
                              |  <-- 200 {prompt_id: X}
                              |  openPrompt(X, graph)          (exists today)
                              |  semanticsRequest(X) ---------> registered adapter
                              |  <-- {scene, frame, camera...} or `declined`
                              |  --> 200 {prompt_id: X} to the bridge

**What this buys**
- ⚑ **Zero bridge changes, for every bridge.** All eleven surveyed bridges post
  to a configurable ComfyUI address; none of them needs to know we exist. Level 2
  becomes as free as Level 1 was.
- The 1.8s correlation gap closes structurally: the id and the request for
  meaning are created in the same place, in the same instant.
- **A host that has nothing to say returns `declined`**, which is already a
  first-class value (WO-E6 measured `declined` on the bypass path). No new
  vocabulary.

**What it costs, stated up front**
- 🔴 **It is a change to the gate**, and `HOST-HOOK.md` says "the gate never
  changes". That promise is about **not changing per host** — this is a one-time
  contract extension that makes every future host cheaper, not a per-host
  special case. But the sentence in HOST-HOOK.md must be amended rather than
  quietly reinterpreted.
- The gate must not block on the host. The natural bound already exists: the leaf
  is not emitted until the artifact appears, which is seconds to minutes later.
  So `semanticsRequest` is **fire-and-forget with a deadline**, and a host that
  misses the deadline yields `declined`, not a stalled generation. ⚑ **A capture
  path must never make its own latency depend on a party it is measuring** —
  WO-C5 established exactly this for the upstream poll.
- The host is answering about a prompt **it may not have originated**. Two
  Blenders against one gate, or a browser tab and a Blender, and the adapter must
  say `declined` for prompts it does not recognise rather than guessing. That is
  a real failure mode and needs its own control.

## Why not the alternatives

| option | why not |
|---|---|
| Fork/patch a bridge to announce first | `BLENDER.md` forbids it, it does not scale past one bridge, and it makes us a maintainer of somebody else's addon |
| Time-window correlation (announce continuously, match by clock) | a heuristic, and `correlation.ts` already labels its heuristic as such on every leaf. Two generations 200ms apart are indistinguishable |
| The addon polls ComfyUI's `/history` itself | duplicates the gate's job, needs the addon to reach ComfyUI directly, and gives the addon a second unattested view of the same facts |
| Require the user to press a button | measured in E6: that is what the script was standing in for. It is not a product |

## The gate this would need

**Observable:** one generation, started from an **unmodified** bridge with **no
human intervention**, produces a leaf reading `host_semantics: supplied`.
**Controls:** (a) no adapter registered → the same generation reads `blind`, not
`declined`; (b) an adapter registered that returns nothing → `declined`; (c) an
adapter that is slow past the deadline → `declined` **and the generation still
completes on time** — assert the artifact's latency is unchanged; (d) a prompt
the adapter does not recognise → `declined`, never invented semantics.
