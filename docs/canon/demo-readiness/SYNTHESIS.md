# Demo readiness — what is actually true

_2026-08-31. Consolidates `comfyui-flows.md`, `c2pa-watermark.md`, `training.md`._

## Two things need a founder decision before engineering

Both are **already in front of a standards body**.

1. **Our own verification instructions fail.** The provenance bundle README —
   and the C2PA MCC filing — give the **base model's hash as the trained
   artifact's**, inside the `sha256sum` step a verifier is told to run. The
   signed manifest is right; the prose is wrong. A failing verification
   instruction is exactly what reads as tampering.
2. **The filing and the signed manifest say the LoRA was "trained via
   Kohya-ss."** It was not — it was a standalone `diffusers+peft` function on
   Modal. The manifest half is hardcoded, so correcting it **requires a
   re-sign**.

## The matrix

| Flow | Provenance leaf | C2PA | Watermark |
|---|---|---|---|
| **txt2img** | **WORKS** — iterations 166-169, all five hashes, `witnessed=1` | signable; **nothing calls the signer** | never built |
| **img2vid** | runner **WORKS**; `/api/generate` drops the metadata | **MP4/MOV work, measured**; WebM 500s | never built |
| **txt2vid** | UNVERIFIED — smoke deferred 06-22, never rescheduled | as above | never built |
| **vid2vid** | **does not exist** — zero hits in the whole history | — | — |
| **training** | **never captured a leaf, ever** | — | — |

## Three scope corrections

- **`vid2vid` was never built.** The real shape is **img2vid**, and it genuinely
  ran — LTX 2b on Modal T4, 90.3s, real fingerprints, a bound input frame.
- **Training was never Kohya.** One event, 2026-07-05, on a branch that is not
  an ancestor of HEAD, whose loss went NaN and **whose provenance record was
  typed in by hand**. Kohya's capture has never reached even a database row.
- **Watermarking was never wired into Studio** — one commit in its entire
  history, zero references from canvas, the proxy or Modal.

## What is shared across every flow

**Nothing signs.** `/api/scruple/c2pa/sign` has **zero in-repo callers** and the
button is hard-disabled. Video C2PA works when invoked by hand; no flow invokes
it.

**The canvas UI's own door throws evidence away.** `/api/generate` passes no
`outputKind`, no model fingerprints, no container manifest — so video is stored
as `.png`, and WO-B1's container manifest has **zero consumers anywhere** despite
being computed, surfaced, and treated as rung one of the trust ladder.

**The watermark derivative cannot enter the chain.** Not an ordering slip: the
lock finalises, the witness inserts `locked_projects`, and the witness then
**403s any further request for that project**. Migration 038's column has been
NULL since July for a structural reason.

## Shortest path to a demo we can defend

**txt2img is one step from demonstrable** and is the only flow with a real
end-to-end record today. In order:

1. **Fix the two filing errors.** Nothing else matters if a reviewer's first
   action produces a mismatch.
2. **Give the C2PA signer a caller** on the txt2img path. The capability exists
   and is unreachable.
3. **Stop `/api/generate` discarding fingerprints, output kind and the container
   manifest.** One door, three losses, and it is what the UI actually uses.
4. **Then img2vid**, which needs the same three plus the `Range`/206 fix — the
   proxy gates on `upstreamRes.ok`, true for a 206, so scrubbing a video mints
   capture rows over fragments.

**Watermarking is a build, not a repair**, and the lock ordering has to be
reversed before a derivative can be witnessed at all. **Training is a build**,
with the job API's only missing piece being a caller.

## What we may say today

A **provenance** conversation is defensible for images and MP4/MOV. A
**marking-measures** conversation is not — and
`docs/website/eu-ai-act-article-50-section-1.md` currently claims video
watermarking that does not exist, resize survival that measurement contradicts,
and a chain hash the payload does not carry.
