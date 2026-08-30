# The integration lifecycle — build, test, then seal

_2026-08-30, founder direction. Supersedes the treatment of P2 as a runtime
completeness proof._

## The correction

P2 had been implemented as *"prove nothing slipped past"* using the ratchet's
per-event counter. That made canvas unfixable-looking (it has no ratchet) and
made C-7's route enumeration a denylist rotting with every upstream release.

**Both problems were artefacts of measuring the wrong thing.** The standard
answer — PCI PTS, P2PE, FIPS 140-3, Common Criteria, EMV L3, SLSA, measured
boot — is:

> **Define the boundary, measure the whole thing, and make any change to it
> require re-approval.**

The approved artefact is the **entire pipeline**, not the capture files. Routes
that exist are the routes in the measured image. A new upstream release is a new
measurement and a new approval.

## The sequence, and why the order is the point

1. **Integrate.** The vendor builds against the SDK: talk to our server, meet
   the L2 floor. Their system, their topology, our contract.
2. **Test end to end.** Conformance probes, self-grade, real leaves flowing.
   Failures here are ordinary and expected — this is where they are supposed to
   happen.
3. **Then seal.** Only once it is compliant and working is the pipeline measured
   and the configuration approved.

**You cannot hash a moving target.** Measuring during step 1 produces a hash
that is stale before it is recorded, and teaches the vendor that the measurement
is noise. Measuring at step 3 makes it the thing that freezes an approved
configuration.

## The three roles, separated

Each of these was previously doing part of another's job.

| Mechanism | Proves | Standard |
|---|---|---|
| **Pipeline measurement** | this is the approved configuration | P2 |
| **Attestation** | the running thing *is* that measurement | P7/P8 — `verified` vs `passthrough` |
| **Counter (ratchet)** | this deployment has not gone dark or been suppressed | operational liveness, **not** the completeness proof |

The attestation row is why the founder's model lands on machinery we already
have: a pipeline hash is taken at approval time, and something must bind the
*running* system to it. Hardware attestation does that → `verified`. Absent it,
the vendor asserts it → `passthrough`. **No new tier is required.**

## Two things this raises that must not be left implicit

### 1. Pre-seal leaves must be distinguishable, permanently
Step 2 produces real leaves from an unsealed pipeline. If they are not marked,
then the moment a vendor seals, they hold a pile of integration-era leaves
**indistinguishable from approved ones** — and the first audit cannot tell which
configuration produced what.

A leaf carries the seal state it was written under. Pre-seal leaves are valid
records of what happened and are **not** claims to the standard. This is the
same distinction as `witnessed: false` on the Kohya route: recorded, honest,
and not pretending.

### 2. "Material change" needs a written definition
Too strict and a vendor reseals on every dependency bump and stops bothering.
Too loose and the seal means nothing. This is EMV L3's question and it has a
documented answer there; ours must be documented too, not left to judgement.

The measurement itself is not the hard part — `build-measurement.ts` already
showed the traps (it digests `.ts` under tsx and emitted `.js` under `dist`,
same component and two measurements; it sorts absolute paths with a UTF-16
comparator; it has no exclusion list). A pipeline measurement inherits all three
and adds the question of what belongs inside the boundary at all.

## What changes in the grader

- **P2** becomes: *is the running pipeline sealed against an approved
  measurement, and is the seal current?* Not: does a counter show no gaps.
- **The counter conjunct is removed from P2** and reported as liveness.
- **Canvas is re-graded under this rule.** Its problem was never architectural;
  it needs its pipeline measured and approved, which is available to it.
- A deployment in `integrating` or `verifying` **cannot claim the standard** —
  compliance stays binary, and the lifecycle state says which side of it a
  deployment is on.
