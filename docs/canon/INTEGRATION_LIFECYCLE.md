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

---

# Part II — as built (WO-22)

_The sections above are the founder direction. What follows is the
implementation, the two judgement calls it forced, and the places where
the direction above turned out to be wrong or to stop short. Those are
stated plainly rather than worked around._

## 6. What exists

| Thing | Where |
|---|---|
| Schema — deployments, seals, lifecycle events, leaf stamps | `lib/db/migrations/046_integration_lifecycle.sql` |
| The pipeline measurement and the boundary manifest | `lib/seal/measure.ts` |
| The material-change definition, executable | `lib/seal/materiality.ts` |
| The fold, the transitions, the ingest-side check | `lib/seal/registry.ts` |
| The write path (key-bearing, local, no HTTP) | `lib/seal/cli.ts` |
| Read-only surfaces | `app/api/v2/seal/deployments`, `.../[deployment_id]`, `.../unsealed` |
| The leaf stamp | `app/api/v2/witness/route.ts` |
| Proof | `test/v2/integration-lifecycle.test.ts` |

It is `lib/builds/registry.ts`'s shape and not a second one: an immutable
signed row per approval, append-only signed events beside it, and a status
that is a **fold as of a time**. WO-15's argument for that shape — a
withdrawal must not require re-signing the publication, and a withdrawn
build must stay checkable for leaves already signed under it — is the same
argument with `reseal` where `withdraw` was, and it is not restated here.
The same Ed25519 signer signs both, because a seal and a publication are
the same kind of statement.

One place the shape differs, deliberately. Build lifecycle events are
**independent facts** folded independently. Deployment lifecycle events
are a **sequence**: `sealed` is legal after `verifying` and illegal after
`integrating`, and that legality is evaluated against the state as of the
event's own instant. So `effective_at` must be monotonically
non-decreasing per deployment — an event inserted *behind* the newest one
re-orders the fold and can make an already-recorded transition illegal
after the fact, which is history rewritten by an append. Backdating into
the gap since the last event is still allowed, for WO-15's reason: a
decision taken at 09:00 and recorded at 11:00 must be able to say 09:00.

## 7. What belongs inside the boundary

§2 above raised the question and did not answer it. The answer, and it is
the same rule that decides materiality:

> **Inside the boundary is everything that can change what a leaf says, or
> whether a leaf is produced at all.** Nothing else.

Four declared classes, each earning its place by naming a way a leaf goes
wrong:

| Class | What it is | Why it is inside |
|---|---|---|
| `capture` | the observing code | changes what a leaf says |
| `config` | hook / surface / placement bindings, the endpoint, the credential | decides **whether** a leaf is produced — Kohya is the standing proof |
| `dependency` | lockfiles, **by content**, never the installed tree | changes what a leaf says, transitively |
| `host` | the host application's declared identity and version | a host upgrade is the ordinary way a hook stops firing |

**Explicitly outside, stated here rather than discovered later:** the OS,
the kernel, the Node/Python runtime, the machine, `node_modules` as an
installed tree, model weights, and the tenant's content. A matching
pipeline measurement means *this is the approved configuration*. It does
not mean *the running system is trustworthy* — that is the attestation
row's job in §3's table, and `tamper-surface.mjs` says the same thing
about its own scope in the same words.

Each entry records whether we hashed it (`content`) or the vendor stated
the digest (`declared`, for container digests and host versions). A
manifest that did not say which would be presenting the vendor's word as
our measurement — the same honesty `passthrough` carries.

### The three inherited traps, answered

§2 named build-measurement.ts's three. A declared manifest answers all
three structurally rather than by patching each:

1. **Two measurements for one component, nothing recording which.** The
   manifest names `src/capture.ts` or `dist/capture.js` **explicitly**, so
   a reader can tell them apart by looking. 045 had to label the
   ambiguity from outside (`measurement_kind`); here it cannot arise,
   because nothing is globbed.
2. **Absolute-path sort under a UTF-16 comparator.** The sharper form of
   this defect, which §2 does not name: `build-measurement.ts` *documents*
   sorting by relative-path byte order and then sorts **absolute** paths —
   so the order it commits to is the order of a string it never hashed,
   and two checkouts at different depths can order differently. Manifest
   ids are relative by construction (absolute ones are refused) and the
   sort is `codePointCompare` — the ratchet's, not a second copy — over
   exactly the bytes that enter the digest.
3. **No exclusion list.** There is no exclusion list here because there is
   no inclusion glob. `tamper-surface.mjs` already gave the reasoning:
   "adding a file must change the hash for a reason we can name, not
   because the glob happened to widen."

A fourth, added: the preimage opens with a **profile string**. Without a
domain tag, a future change to the formula produces a different number
with no way to tell it apart from the same formula over different bytes.

## 8. Material change — the definition

> **A change is material if it could change what a leaf says, or whether a
> leaf is produced at all.**

"Could", not "did". The vendor does not get to argue that their edit
happened not to matter; the question is whether the class of thing they
edited is capable of mattering. The asymmetry is deliberate — the party
making the judgement is the party who benefits from the answer being no.

**What was taken from PCI P2PE and EMV, and what was not.**

*From P2PE — scope by security impact, not by file churn.* P2PE routes a
change to a listed solution to a delta assessment only when it touches the
parts carrying the security property (POI firmware, applications in the
POI, key management, the decryption environment); documentation and
non-cryptographic feature work are attested by the provider and do not
re-open the listing. **Taken:** the trigger is the *class* of the thing
that moved. **Not taken:** the assessor in the loop — we have none, so the
classification is computed from the manifest diff and recorded on a signed
event, which makes the judgement attributable rather than implicit.

*From EMV type approval — an expiry that does not depend on change.* EMVCo
approvals lapse on a term whether or not anything changed, and a
maintenance change renews rather than requiring a new approval. **Taken,
and it is the load-bearing borrowing.** A materiality rule permissive
enough to let dependency bumps through is only defensible if the seal
cannot sit untouched forever.

*From both — the vendor declares and the declaration is recorded.*

**The three classes:**

- **`material`** — mandatory reseal, and the deployment cannot claim until
  it is sealed again. Any `capture`, `config` or `host` digest change; any
  entry added or removed **in any class** (the boundary itself moved, and
  the removal is the case a permissive rule misses — deleting the config
  entry that names the endpoint is how you stop sending leaves); and a
  `content` → `declared` switch at an identical digest, because the bytes
  did not move but who is vouching for them did.
- **`consequential`** — a `dependency` digest change. Recorded as a signed
  `drift` event, **counted**, and not an immediate reseal. This is the
  case the definition has to get right: forcing a reseal here is the
  "vendor stops bothering" failure; waving it through is the "seal means
  nothing" failure. **The answer is a budget** —
  `CONSEQUENTIAL_CHANGE_BUDGET` (8) forces a reseal. An individual bump
  costs nothing; a pipeline quietly rebuilt out from under its seal one
  dependency at a time cannot keep claiming.
- **`administrative`** — anything outside the declared manifest. No
  effect, but named as a class so "we decided this does not matter" is a
  recordable judgement rather than a silence.

**And a term.** `SEAL_TERM_DAYS` (365) expires a seal nothing touched.
Re-applying the *same* seal is legal as a renewal — EMV's maintenance
approval, and the reason the term is defensible at all — but is **refused**
as a way to clear a declared material change, which would be re-asserting
the configuration you just said you changed.

This is deliberately at odds with one line of `PUBLISHED_BUILDS.md` §1,
which refuses future-dated lifecycle events on the grounds that "scheduled
withdrawal, if it is ever wanted, should be a named concept with its own
surface, not a side effect of a date field". Agreed — and the term **is**
that named concept: a constant of the scheme, surfaced as
`seal_expires_at`, never an operator-typed date on an event.

**What this definition is not.** It is not a source-diff rule: two
`capture` trees differing only in a comment are a material change here.
That is the correct trade — a rule that must decide whether a diff is
semantically inert must be right about a program's behaviour, and it will
be wrong silently. A digest is right or it is not.

## 9. How pre-seal leaves are marked

Every leaf carries `seal_state`, and `seal_ref` **only when that state is
`sealed`**. The vocabulary is the estate's existing one; nothing was
coined for a distinction that already had a word:

| Value | Means |
|---|---|
| `integrating` `verifying` `sealed` `resealing` | the fold, as of the instant the leaf was written |
| `unregistered` | a deployment was **declared** and we have no record of it under this tenant. 045's `unpublished`, one level up |
| `undeclared` | nothing was declared — canvas, the plugins. 045's word, for 045's case |
| `unchecked` | **our** failure, named rather than swallowed. An inconclusive is never a pass |
| `NULL` | the question was never asked. Every row written before migration 046 |

A leaf is **stamped, never refused**, on any of these. Refusing would not
un-produce the artifact; it would produce an artifact with no leaf,
converting a flagged fact into a silence — §4.2's trade, made again. The
report is `GET /api/v2/seal/unsealed`, the shape
`GET /api/v2/builds/unrecognised` already has, because a status nobody can
read is the same as no status.

`seal_ref` is deliberately **NULL during `resealing`**. Such a leaf has a
last-approved seal, and stamping it would read as "approved under X" —
which is the one thing not true of it, since `resealing` means the
configuration moved *away* from X. The last approval is still recoverable
from the fold as of that leaf's timestamp by anyone who wants it.

## 10. Where the direction above was wrong or stopped short

Said plainly, because working around it silently is how a spec stays
wrong.

1. **"A deployment" is used throughout and never defined.** Nothing above
   says what a deployment *is*, how it is identified, or how a leaf knows
   which one produced it. Implemented as a registered `deployment_id`,
   resolved at ingest from (a) what the caller declared, then (b) the
   MACed component's binding, then (c) `undeclared`. The declared id is
   checked against the calling tenant — it is a bare string on the wire,
   and without that check a tenant could stamp their leaves with somebody
   else's `sealed`.

2. **`resealing` is not in the direction at all.** §"What changes in the
   grader" names `integrating` and `verifying` as the states that cannot
   claim, and never names the state a *sealed-then-changed* deployment is
   in. It is the state the whole materiality section implies and does not
   provide.

3. **"A leaf carries the seal state it was written under" stops one step
   short.** It does not say what the state is for a leaf with **no**
   deployment — which is most of the estate's traffic today (canvas, the
   plugins) — nor for one naming a deployment we do not have. Those needed
   `undeclared` and `unregistered`, and conflating either with
   `integrating` would have been a false statement about a pipeline that
   does not exist.

4. **The `witnessed: false` analogy is right about honesty and wrong about
   mechanism.** `witnessed` is a boolean about one operation's outcome.
   Seal state is a fold over time and therefore needs an **as-of instant**,
   which `witnessed` never did. Take the analogy for the posture — recorded,
   honest, not pretending — and not for the shape.

5. **Sealing is not a self-serve act, and §"The sequence" reads as though
   it might be.** There is no HTTP write route. A deployment that can move
   its own lifecycle state can grant itself the right to claim the
   standard, which is a vendor grading their own exam; and WO-15's reason
   applies unchanged — the only thing that legitimately authorises an
   approval is possession of the signing key, and no `/v2` scope is that
   credential. `app/api/v2/seal/**` is read-only.

6. **§"What changes in the grader" says canvas "needs its pipeline
   measured and approved, which is available to it" — it is not yet.**
   Canvas does not ingest through `POST /api/v2/witness`; it goes through
   `lib/iterations/ingest.ts`, which this work order did not touch. Canvas
   leaves therefore carry `seal_state = NULL` today, which is honest (the
   question was not asked) but is not the re-grade the direction promises.
   Stamping the canvas ingest path is the outstanding piece.

7. **A gap found by the test, recorded because it was not obvious.** The
   first cut committed only the manifest's entry *count* to the seal
   preimage, reasoning that the measurement is a digest over the manifest
   and so signing the measurement signs it. It does not: the measurement
   is over the *normalised entry set*, while `manifest_json` is the bytes
   a verifier actually reads. A row whose `manifest_json` was swapped
   still verified. The seal now commits to the stored bytes directly —
   **sign what you store** — and `verifySealMeasurement()` remains a
   separate check, because "the manifest was edited" and "the manifest
   does not produce the measurement it claims" are different incidents.
