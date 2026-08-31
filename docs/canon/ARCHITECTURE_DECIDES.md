# The architecture decides, not the declaration

_2026-08-31, founder direction. Resolves the residue of DEFECT-2 and the
anti-gaming question._

## The concern I had been treating as technical

The class model scopes an audit by the profile a vendor declares — which
surfaces they have, which hooks they implement. WO-24 was honest that this only
narrows the problem: *"two profiles differing only in whether they admit to a
filesystem surface get different probe-4 scopes."* A vendor with a leaking
surface could omit it, have the probe scored out of scope, and pass.

I was looking for a type or a check that closes that. There isn't one, and
there does not need to be.

## The founder's resolution

**The architecture decides.** The class, the placement and the locus are not
choices a vendor makes on a form — they fall out of what they actually built.
A pod with a tenant shell is not `server-library` because someone wrote
`server-library`.

**The vendor has to explain and embed.** Integration is not a questionnaire; it
is describing your system well enough to wire our code into it. The explaining
is inherent to the work, not an extra step we impose.

**1. A vendor will not hide it, because hiding is counterproductive.**

**2. And it will be obvious at the audit.**

## Why (1) holds — and it is a symmetry, not an assertion

Hiding a surface does not buy a stronger claim. It buys a **narrower** one,
because the class scopes what you may say as well as what you must prove.

So a vendor who conceals a surface lands in one of two places:

- The surface is **core to their product** → they have hidden the thing they
  wanted the credential for. The claim no longer covers their actual business.
- The surface is **peripheral** → the narrowed claim is **true**, and a true
  narrow claim is a fine outcome.

**Both are acceptable.** The only bad case is concealing a core surface *and
getting away with it* — which is (2)'s job.

This is the same incentive shape as PCI scope: a merchant who under-declares
gets a narrower attestation, which is commercially worse. **The fraud vector in
a certification programme is over-claiming, not under-declaring** — and our
whole model already refuses over-claims by computing assurance rather than
accepting it.

## Why (2) holds

Phase 2 is an **audit of the built thing**, not a review of a form. An
undeclared surface in a system you are reading is visible — that is what
auditors do, and it is why the phases have different toolchains
(`TWO_PHASES.md`).

WO-24 put it precisely from the other side: *"the rule is checkable against the
profile; only a run from the tenant position checks it against the world."*
That run is the audit. Having one is the point.

## What this changes in the tooling

**The declaration is an input to be checked, not a fact to be trusted.** Phase 2
must include **architectural review** alongside probe execution — reading the
system against what was declared, and raising a finding where they disagree.

Consequences:

- The vendor's architecture description becomes a **first-class artifact** they
  produce and we review — a Security Target in Common Criteria's sense, which is
  the layer `CAPABILITY_CLASSES.md` already borrows from.
- **A declaration/architecture mismatch is a finding**, and one that should
  weigh heavily: an undeclared surface is not a paperwork slip, it is the one
  move the model cannot defend against on its own.
- WO-24's genuine closure stays the sharp edge underneath: **a not-applicable
  probe whose run reports pass or fail — rather than the `inconclusive` a real
  absence produces — voids the exemption.** An observation beats a declaration,
  automatically, without waiting for a human to notice.

## What this settles about who audits

The mechanism is **architectural review plus probes**, not self-declaration. So
the question is who performs that review, not whether the model can survive
without one — it cannot, and was never designed to.

That keeps every option in `oss-study/sonobuoy-conformance.md` open (first-party
now, third-party later, or the CNCF self-run-and-submit shape with
reproducibility-triggered revocation), because all three assume a reviewer. It
rules out only the option nobody proposed: **grading a vendor purely on what
they tell us.**
