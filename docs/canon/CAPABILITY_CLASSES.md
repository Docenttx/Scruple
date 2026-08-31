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

---

# What landed — WO-24, 2026-08-31

The direction above is unchanged. This section is what it became in code, plus
four places the direction was wrong or underspecified and had to be decided.

Code: `lib/capture/classes.ts` (the four classes, the locus axis, `scopeProfile`),
`lib/capture/surface.ts` (`capabilityClasses`, `custodyLocus`,
`custodyCorroborator` on `HostCaptureProfile`; `custody` on `HostAssurance`),
`packages/scruple-conformance/src/classes.ts` (the grader's reading surface),
`test/v2/capability-classes.test.ts`, `test/v2/conformance.test.ts`.

## The partition, and why it is the load-bearing part

Each class partitions each axis into **required / permitted / not-applicable**,
and `test/v2/capability-classes.test.ts` asserts the three sets are disjoint and
cover `CAPTURE_HOOKS` and `CAPTURE_SURFACES` exactly. A hook that falls through
the partition is a hook nobody decided about, which is the state this layer
exists to end — and the partition is also what makes the anti-gaming rule
mechanical rather than advisory:

- an item the class marks **not-applicable** and the profile declares anyway is a
  **finding**, and it names the class that *requires* that item (`CF-02` hooks,
  `CF-03` surfaces);
- an item the class marks **required** and the profile omits is a **finding**
  (`CF-05`) — a class floor, not an item this deployment failed;
- an item the class marks **permitted** raises nothing, which is why the
  permitted set has to be written out rather than inferred as "everything left".

Declaring a second class **cannot dilute the first**: `scopeProfile` takes the
**union** of requirements and the **intersection** of not-applicables. Declaring
*no* class is a finding (`CF-01`) and buys the **broadest** audit —
`inference-host` — which is the only incentive structure under which "the broader
class applies" is a rule rather than a preference.

## The probe sets, which is where the classes actually differ

| | required | not applicable |
|---|---|---|
| `inference-host` | P-01…P-07 | P-04 *when the profile declares no `filesystem-watch`* |
| `training-host` | P-01…P-04, P-06, P-07 | **P-05** — a checkpoint is a file, fetched as one or not at all |
| `authoring-application` | **P-03, P-06** | P-01, P-02, P-05, P-07 |
| `asset-custody` | P-03, P-04, P-06 | P-05 |

## Not-applicable is checked, and there are three ways it loses

1. **Contingency.** `inference-host`'s probe-4 exemption is *contingent on the
   absence of a `filesystem-watch` surface*, checked against the profile's own
   `surfaces` list. Declare the surface and probe 4 is required again, with the
   void recorded on the item.
2. **Observation.** A not-applicable probe for which the attached run reports
   `pass` or `fail` — as opposed to `inconclusive`, which is what a genuine
   absence produces — **voids the exemption and raises `CF-04`**. An observation
   beats a declaration.
3. **Union.** A second declared class that requires the item.

## The three-way distinction

`not-applicable` / `satisfied` / `failed` / `unmeasured`, and the fourth is the
one the grader used to spell as one of the others. A required probe with no
admissible result is `unmeasured`, listed on the report, and aggregates as **not
passed** everywhere — WO-14's rule at class scope. A borrowed run
(`ProbeRun.subject ≠ this path`) supplies **nothing**, so every applicable probe
is unmeasured rather than satisfied by somebody else's evidence.

## Custody

`custodyAssuranceFor(locus, effectivePlacement, corroborator?)` is total over
5 × 4 and produces the permitted **sentence**, the sentences it **must not
imply**, and the conditions. Two rules matter:

- **`ephemeral` + `unattested-client` resolves to no claim at all.** `ephemeral`
  is a claim about persistence, not about isolation, and placement decides the
  second. `vendor_custom_handler` is the live case.
- **The custody refusal and the assurance refusal agree by construction**, and a
  test asserts it over all 20 cells. A configuration refused by one half of the
  model must not be permitted by the other.

Claim wording: the **specific determination wins over the class default**, in
both directions. `inference-host` forbids "this is the complete history of the
project" because most members cannot say it; canvas's `vendor-custody` locus is
the determination that this member can. Nothing may appear in both columns.

---

# Four corrections to the direction above

**1. "Not all eight bind every class" did not hold.** Working through the four,
**no P-item drops out of any of them.** What differs between classes is the
*evidence each can offer* — the probe set — not which requirements bind. The
tempting exception is `authoring-application`'s P4 under the inverted threat
model, and it goes the other way: an authoring vendor whose user supplies both
the identity and its authenticator has handed the later disputant their entire
argument, so P4 binds **harder** there, not less. The `notApplicablePItems`
mechanism is implemented and exercised anyway, because a fifth class will need
it, and because a rule that exists only in prose is a rule nobody re-reads.

**2. "Probes 1–3 are meaningless where there is no tenant/vendor split" is right
about 1 and 2 and wrong about 3.** P-03 asks where the signing key lives, and
that question **survives the inversion**: the disputant's whole case is "the
author forged it". P-03 is therefore *required* for `authoring-application`, and
it is one of only two probes that are.

**3. A surface requirement cannot be a flat all-of list.** An inference host must
observe the delivery path, and whether that position is a gate in front of the
process or a call inside it depends on whether the vendor owns the handler —
both are real coverage of the same path. Hence `requiredSurfacesAnyOf`. Making
it all-of would have failed `vendor_managed`, a `server-library` vendor calling
the SDK from its own handler, on a gate it has no reason to install. **The
disjunction is coverage, not softness**, and it must never be used to do
placement's job: `surface.ts`'s "SURFACE DOES NOT AFFECT ASSURANCE" still holds.

**4. The locus axis needed a fifth value.** See below.

## `tenant-custody-corroborated` — the fifth locus, and why it earns its place

`docs/canon/custody-study/fusion.md` §6.3. Fusion fits none of
`CUSTODY_LOCUS.md`'s four cleanly: its **local file** is `tenant-custody` (a
plain store-compressed ZIP with no integrity field), while its **cloud version
sequence** is append-only *in fact* — zero delete operations across an 8,289-line
OpenAPI spec, and Autodesk stating that BIM 360's tombstone route does not apply
to Fusion Team at all.

- Folding it into `tenant-custody` throws away a verified assurance gain.
- Folding it into `vendor-custody` is **worse**: that value means the
  *integrator's* boundary — a party to the standard whose topology we can probe.
  Autodesk is neither.

**The shape is general, which is the test it had to pass.** "Files rest in tenant
custody and an independent operator holds an append-only, non-tenant-writable
record of the state sequence" also describes Drive or Dropbox version history, a
git remote nobody can force-push, and S3 with object lock. It is not a
description of Fusion.

**And it earns its place by being able to degrade.** A locus a vendor could hold
by naming it would be DEFECT-1 one axis over. So it works the way
`resolvePlacement` does: the value is earned by naming the corroborating party
and citing its guarantee, and `resolveCustodyLocus()` reduces an unearned claim —
no corroborator, or a record the tenant can rewrite — back to plain
`tenant-custody`, with the degrade printed rather than applied silently
(`CF-10`).

Its claim, `corroborated-moments`, sits between the two and **stops short of
`complete-history` for three reasons carried as conditions, not caveats**: the
gaps between saves are real and unclosable in this locus; the corroborator is
*asserted*, not proved, so corroboration means "a second party would have to lie
too" rather than "the record is provable"; and corroboration is only as dense as
the connection. `CustodyCorroborator.verifiable` distinguishes `asserted` from
`cryptographic` so that fusion.md's open question 2 has somewhere to land.

The corroborator record must be **scoped**. "Fusion is tamper-resistant" is false
of the parametric timeline (rewritable through Fusion's own scripting API;
`design.designType = DirectDesignType` destroys it in one assignment, recorded
nowhere) and false of the local file, and true only of the cloud version
sequence. A modifier that let a vendor say "our host tracks versions" without
saying *which record, held by whom, under what documented guarantee* would
launder the false general claim on the true specific one.
