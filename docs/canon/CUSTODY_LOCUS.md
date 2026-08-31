# Custody — where files rest between witnessed events

_2026-08-30, founder direction. The axis the `asset-custody` class turns on._

## What custody actually protects — and it is not the artifact hash

A bait-and-switch on a single artifact is **already defeated**. We witnessed
`hash(A)`; the user presents `B`; `hash(B) ≠ hash(A)` and the receipt does not
match. No custody mechanism is needed for that.

What custody protects is **continuity between witnessed events.**

The claim a project-based integration wants to make is not *"this file has this
hash"* — it is *"this project passed through these states and nothing happened
in between that we did not see."* If files rest somewhere the user can alter
them **between** events, that history has undetected gaps.

It is the completeness problem again, moved from **across surfaces** to **across
time**.

## The locus axis

The same shape as placement, and the fourth value exists for the same reason:
so the model can say no.

| Locus | Files rest | What can be claimed |
|---|---|---|
| **`ephemeral`** | nowhere — memory only, hashed and delivered | nothing to tamper with; strongest, and narrow |
| **`vendor-custody`** | inside the vendor's boundary; the tenant reaches them only through vendor APIs | every mutation crosses a path the pipeline sees, so the **history is complete** |
| **`shared-custody`** | vendor space, but tenant has direct reach — mounted volume, shell, object-store credentials | mutation outside the pipeline is possible; **detectable, not preventable** |
| **`tenant-custody`** | the user's own machine or storage | outside the boundary entirely; custody is **asserted, not enforced** |

### Fifth value, added 2026-08-30 (WO-24, from the Fusion study)

**`tenant-custody-corroborated`** — files rest in tenant custody, but an
**independent third party** holds an append-only record of the sequence.

It is not `tenant-custody` (that discards a verified gain) and not
`vendor-custody` (that means the *integrator's* boundary — a party to the
standard whose topology we can probe; Autodesk is neither).

Fusion is the case that forced it. Autodesk's Data Management API v2 OpenAPI
spec contains **zero `DELETE` operations anywhere**, and Autodesk states that
BIM 360's tombstone workaround does not apply to Fusion Team, where a file
version cannot be deleted at all. **Fusion versions are append-only in fact.**
The shape generalises — Drive and Dropbox version history, a git remote nobody
can force-push, S3 object lock.

**It earns its place by being able to degrade.** `resolveCustodyLocus()` reduces
it to plain `tenant-custody` when no corroborator is named or the record is
tenant-writable, and the degrade is **reported, not applied silently** — the
`resolvePlacement` precedent, one axis over. A `CustodyCorroborator` must name
the party, the guarantee, a citation, and whether it is `asserted` or
`cryptographic`.

**Scope the corroboration narrowly or it lies.** Fusion's corroborator covers
the **cloud version sequence only**. The parametric timeline is trivially
rewritable through Fusion's own scripting API — `designType = DirectDesignType`
destroys it in one assignment — and the local `.f3d` is a store-compressed ZIP
with no integrity field. So *"Fusion is tamper-resistant"* is false in general
and true in exactly one place, and the declaration says which.

Its claim is **`corroborated-moments`** — stronger than bare witnessed moments,
and deliberately short of `complete-history`.

## The two honest sentences

This is where the class's permitted claim wording comes from, and the difference
is not cosmetic:

- **`vendor-custody`** supports *"this is the complete history of the project."*
  Every change was logged by the server **and** captured by the pipeline.
- **`tenant-custody`** supports only *"these states were witnessed at these
  times."* Which is still worth something — it is what a notary does — but it is
  a **different claim**, and a vendor must not be able to imply the first while
  holding the second.

`shared-custody` sits between: the history is complete **unless** someone worked
around the pipeline, and the record can show *that* a gap exists without showing
what happened in it.

## Two caveats worth stating before anyone leans on them

**In-memory is not automatically safe.** `ephemeral` means nothing rests where
it can be altered *between* events. It does not mean memory is beyond reach — if
the tenant has code execution in the same process, memory is theirs. `ephemeral`
is a claim about persistence, not about isolation; **placement still decides the
second.**

**And `ephemeral` fits inference, not authoring.** Generate, hash, deliver, keep
nothing — that is an inference host. A project-based application *is* persistence;
telling an authoring vendor to hold nothing at rest is telling them not to be
the product they are. This is exactly why `asset-custody` and `inference-host`
are different classes rather than tiers of one.

## Why the plugins land where they do

Fusion, Blender, Toon Boom, Adobe are `tenant-custody` by construction — the
artist's files are on the artist's disk. That is not a deficiency to be
engineered away; it is what the product is.

And it is consistent with those hosts' inverted threat model: the user is
attesting **their own** work, so files resting in their custody is the normal
case, and the claim is a notarial one. Fusion's native project tracking is the
strongest version available in that locus — tampering means hacking Fusion —
which is why it grades better than Blender and why *"we did not build this
guarantee, Autodesk did"* is an honest thing to say rather than a gap.

## What this adds to the class

`asset-custody` declares a **locus** the way a capture class declares a
placement, and the assurance function extends the same way: **locus and
placement together decide what may be claimed, and neither alone is sufficient.**
A vendor with perfect capture and `tenant-custody` storage has witnessed
moments, not a history — and should say so.
