# Capability classes — phasing the skeleton by what the vendor installs

_2026-08-30, founder direction. Adds the layer above `HostCaptureProfile`._

## What exists and what is missing

`lib/capture/surface.ts` has nine `CANON_HOST_PROFILES` — `comfyui`,
`kohya_today`, `fusion_attested` and so on. Each describes **one specific
integration**: its hooks, surfaces, placement, attestation.

That is a **Security Target** in Common Criteria's sense — this product, these
claims. What is missing is the **Protection Profile**: the *class* of product,
with the requirements every member of it must meet, that a specific integration
is measured **against**.

Without it, every vendor is graded against one monolithic standard, and anything
their shape does not have reads as a **gap** rather than as **out of scope**.
That is not hypothetical — it is exactly why probe 4 looked like a canvas
failure when canvas simply has no filesystem surface, and it is the residue of
WO-5's DEFECT-2.

## The classes

Named by what the vendor actually installs. These differ in kind, not degree —
**inter-inference workflow capture and folder/UI tamper resistance are not the
same problem** and should not ship as one bundle.

| Class | Vendor | Hooks | Surfaces | Threat model |
|---|---|---|---|---|
| **`inference-host`** | HF, RunPod, hosted ComfyUI | `graph.execute`, `artifact.produced` | network-gate **and** filesystem-watch | tenant is the adversary |
| **`training-host`** | anyone hosting Kohya, torch, Diffusers | `model.write` | filesystem-watch (a checkpoint is a file — no fail-closed point) | tenant is the adversary |
| **`authoring-application`** | Fusion, Blender, Toon Boom, Adobe | `document.save`, `artifact.produced` | host-api-callback | **the user attests their own work**; the adversary is a third party disputing it later |
| **`asset-custody`** | project folders, DAM, asset stores | `document.save`, `idle.tick` | filesystem-watch | continuity of files at rest, between events |

The fourth is the founder's "folder/UI tamper resistance" and **we have not built
it.** It is not capture at all — capture answers *what happened at this moment*;
custody answers *is what I stored still what I stored*. Fusion is the closest
thing we have to a customer for it, because it already tracks project work
natively.

Note `authoring-application` inverts the threat model. On an inference host we
prove what a machine did against a tenant who may lie. In Fusion the user
**wants** to be bound, and the adversary is whoever disputes the claim later.
That inversion is why "proof of no AI" is a real market there, and why grading
those hosts against inference-host probes was always going to produce nonsense.

## What a class carries

1. **Required hooks and surfaces** — and, critically, **which are not
   applicable.** Not-applicable becomes a *declared property of the class*,
   checkable, rather than a hole a grader has to guess at.
2. **Applicable P-items.** Not all eight bind every class.
3. **Required probes.** Probe 5 (WebSocket retrieval) is meaningless for a
   training host. Probes 1–3 are meaningless where there is no tenant/vendor
   split at all.
4. **Permitted claim wording.** Scruple-witnessed *inference* is a different
   sentence from Scruple-witnessed *authorship*, and a vendor should not be able
   to imply the other. This is the trademark clause's mechanism, applied at the
   class level.

## How this phases the skeleton

The SDK ships as **modules matching classes**, and a vendor installs the ones
their class needs. Phase 1 (integration) wires the modules that class requires;
Phase 2 (audit) grades against that class's required set and nothing else.

This also gives the build phases a natural order for a vendor doing more than
one thing — a host that both serves inference and stores projects installs two
classes and is audited against both, rather than against a union nobody
designed.

## The rule that keeps it honest

**A class may not be chosen to avoid a requirement that genuinely applies.**
The class is determined by what the vendor installs and offers, not by which
audit they would prefer. Where a deployment spans two classes it is audited
against both; where it is ambiguous, the broader class applies.

Otherwise this becomes the gradations-of-certification problem the trademark
terms exist to forbid — a vendor picking the profile that grades easiest and
claiming the name.

## Standard language, natively

The founder's other point: use the assessment vocabulary **in the pipeline
itself**, not as a compliance layer bolted alongside. Class, target, finding,
observation, disputed, in-scope, not-applicable, remediation, re-audit, seal.

Our own Studio goes through the same pipeline with the same words — which is
`STUDIO_IS_AN_EXEMPLAR.md`'s rule, and the reason it is worth the effort: if the
vocabulary only fits vendors and not us, we have built a compliance department
rather than a standard.
