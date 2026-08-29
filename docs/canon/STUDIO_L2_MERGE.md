# Merging Studio with the L2 work

**Status:** Analysis and plan. Nothing implemented.
**Written:** 2026-08-29
**Companions:** `L2_FLOOR.md`, `CANON_SKELETON.md`, `WO-05-studio-comfyui-kohya.md`

---

## Why this document exists

Scruple Web Studio is a **standalone product** with ComfyUI and Kohya
running inside it — not a plugin for someone else's application. It is
also, by a distance, the strongest provenance capture in the estate:

- the full ComfyUI workflow graph as JSON
- **dual** model fingerprints, content and structural
- a container manifest carrying real git-commit SHAs plus content hashes
  of every custom node
- execution backend and machine identity

No plugin comes close to that. Toolchain pinning at git-SHA granularity
is a genuinely strong claim.

And none of the L2 work done on 2026-08-26/27 has reached it. Three
separate capabilities are missing, for three separate reasons, and they
are worth keeping apart because the fixes differ enormously in size.

---

## Gap 1 · Studio has never produced a C2PA manifest

**Evidence.** `grep -rn "signAsset|c2pa"` across `lib/canvas/`,
`app/canvas-proxy/` and `modal/scruple_runner.py` returns **nothing**.
There is no code path from Studio to the C2PA signer at all.

This is the largest gap and the most surprising one: Studio produces
images and video — precisely the media where §9.1 applies and where the
GPSA's asserted MIME list is strongest. The plugins that *do* reference
C2PA are all working on file types that are harder to sign, or in
ToonBoom and Blender's case were not really signing at all.

**Size:** substantial. Needs an asset handle the signer can read, the
CVM running, and a decision about where in the proxy flow signing
happens — at `/prompt` completion, or on explicit user action.

---

## Gap 2 · Studio's leaves are unsigned, and the fix is nearly free

**This is the one to do first.**

Studio's proxy calls `captureOutput` → `ingestIteration` →
`witness.witnessIteration()` → the witness server at `:5799`. That is
**the same witness server H-1 just taught to ECDSA-sign leaves.**

So Studio is already on the H-1 path. What is missing is one step at the
other end: `lib/iterations/ingest.ts:359-361` stores
`witnessResult.witness_id`, `.server_timestamp` and `.signature` — the
HMAC — and **discards the new `leaf_signature`, `leaf_signer_key_id` and
`leaf_signature_alg` fields entirely.**

The witness returns them. scruple-web throws them away.

**Size:** small. Three columns on `iterations`, three assignments in
`ingest.ts`, and Studio's leaves become independently verifiable —
along with every other integration that ingests through the same path.
This is the cheapest L2 win available anywhere in the estate.

**Consequence worth stating:** `/api/v2/verify` reads `witness_signature`
to decide `independently_verifiable`. Until this lands, it reports the
HMAC's presence, not the ECDSA signature's — so it can answer `true` for
a leaf that no third party can actually check. That is a correctness bug
in the verify route, introduced by me, and it is fixed by the same change.

---

## Gap 3 · Watermarking does not reach Studio, and barely reaches anything

**Evidence.** No `watermark` reference exists anywhere in `lib/canvas/`,
`app/canvas-proxy/` or `modal/`. The implementation lives in
`lib/watermark/{embed,apply}.ts` and is invoked from exactly two places:
`app/api/lock/local/route.ts` and `app/api/v2/mark/route.ts` — and the
`/v2/mark` reference currently reports it as outstanding rather than
applying it, because `services/watermark` has no HTTP server.

So the §9.2 modality that Standard v1.7 promoted to a **mandatory peer of
C2PA** under EU AI Act Article 50 is reachable only from a paid local-lock
flow, on already-stored image iterations, in a product that never calls it.

**Size:** medium. The embedder exists and works; what is missing is a way
to reach it, which is the same missing watermark endpoint the canon
skeleton already identifies.

---

## The order I would do these in

1. **Gap 2** — store the leaf signature in `ingest.ts`. Smallest change,
   largest reach: every integration on the ingest path gains independent
   verifiability at once, and it fixes the `/v2/verify` correctness bug.
2. **Gap 3** — the watermark endpoint, then call it from Studio. Studio
   is the right first caller because its output is always watermarkable
   media, unlike the CAD trio.
3. **Gap 1** — C2PA in Studio. Largest, and it needs the CVM up, so it
   is gated on a decision that is not an engineering one.

None of these is blocked by the plugin SDK question, and none of them
should wait for it. Studio is not an adapter and does not need one.

---

## What this changes about the canon skeleton

`CANON_SKELETON.md` was written treating all eleven integrations as one
category needing one shared client. Studio is not in that category, and
saying so is not a demotion — it is the most capable of them.

The revision list this implies is tracked separately: `/v2/witness`
currently accepts a workflow graph and **discards it**
(`app/api/v2/witness/route.ts:115` is a no-op stub), carries no
`model_fingerprints_hash`, and carries no `input_hash`. Three of the
witness server's eight canonical leaf fields are dropped. A leaf created
through the canon surface is therefore weaker than one Studio already
produces today — which is the wrong way round for something called canon.
