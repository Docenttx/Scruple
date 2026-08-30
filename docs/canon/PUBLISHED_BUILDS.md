# The published-builds registry

_H-4 §4.3, closing §10 C-4. WO-15._

C-4 recorded the defect in one line: **"'The server can check the claimed
build is one we shipped' presumes a published-builds registry that does not
exist."** Until it did, a claimed `build_measurement` was compared only to the
value the same component had provisioned with, which notices that a component
*changed* and cannot tell a build we shipped from a string somebody typed.
That is drift detection. This document is what replaced it, and — more
carefully — **what it is and is not worth.**

---

## 1. What the registry holds

Two tables (migration `045_published_builds.sql`).

**`published_builds` — immutable, one row per measurement.** Component name,
version, how the measurement was taken, when it was published, and a detached
Ed25519 signature over exactly those facts. A row is written once at
publication and is never updated or deleted.

**`published_build_events` — append-only, everything that happens afterwards.**
`withdrawn`, `superseded`, `reinstated`. Each event is separately signed and
carries its own `effective_at`, which is when the decision took effect and not
when the row was written. A build's standing is the **fold of its events as of
a reference time**, never a column read as of now.

### Why not one mutable row with a `withdrawn_at`

Two reasons, and both are about evidence rather than tidiness.

**The publication signature would have to be re-signed to withdraw.** If
`withdrawn_at` lives on the signed row, withdrawing means recomputing the
signature over the new contents. After that there is no longer any artifact
attesting that the build *was published, unwithdrawn, on the day the leaf was
signed* — which is exactly the question a verifier holding an old leaf has.
Withdrawal would destroy the evidence that makes withdrawn leaves checkable.

**A withdrawn build must remain checkable for leaves already signed under it.**
Deletion is therefore not available, and neither is a status that only knows
`now`. `buildRegistryStatus(measurement, asOf)` takes the instant as an
argument; a withdrawal effective at T+1 is not in the fold for a leaf verified
at T and cannot reach backwards. Withdrawal changes what a component should be
**running**. It does not retroactively unpublish what it was running.

This is migration 041's rule applied one level up: a counter gap that later
drains is *resolved*, never deleted, because "it went wrong and then recovered"
is a different fact from "nothing ever went wrong."

Two dates a lifecycle event may not carry, both refused at write time:

- **In the future.** A withdrawal that has not taken effect reads exactly like
  one that silently did nothing, and withdrawal is the one signal here that must
  never be a no-op. Scheduled withdrawal, if it is ever wanted, should be a
  named concept with its own surface, not a side effect of a date field.
- **Before the build's own `published_at`.** Backdating a withdrawal past the
  publication would be a way to reach back and restate leaves that were ingested
  under a published build — the exact retroactivity the as-of fold exists to
  prevent, arriving through the front door.

Every instant is normalised to `Date#toISOString()` on write and on query. The
fold compares `effective_at <= as_of` lexicographically, in SQL and in
TypeScript alike, so `2026-08-05T00:00:00Z` and `2026-08-05T00:00:00.000Z`
would name the same moment and sort differently. §10 C-1 is the same lesson
about the MAC preimage: leaving a format undefined does not make it flexible,
it makes it two formats. A withdrawal is in force **at** its effective instant,
not after it.

Withdrawal and supersession are folded **independently**. Collapsing them into
one last-event-wins status has a bug that only appears in the field: a build
withdrawn on Monday and superseded on Tuesday — the ordinary sequence, since
you normally ship the replacement *after* you pull something — would come out
`superseded`, i.e. quietly un-withdrawn by a housekeeping event. Only an
explicit `reinstated` undoes a withdrawal, and the withdrawal stays on the
record when it does. History is corrected by appending.

---

## 2. What the signature is worth

Ed25519 over the canonical preimage — `lib/ratchet/ratchet.ts`'s
`canonicalPreimage`, the same code-point-sorted, float-refusing serialisation
the event MAC uses, because two canonicalisations in one estate are two
formats (§10 C-1 records what it cost to leave that undefined once).

The private key lives in `SCRUPLE_BUILD_REGISTRY_KEY_HEX` and **never in the
database**. So:

- **Write access to the database is not publication.** Someone who can INSERT
  a row cannot make it verify.
- A registry served from a host you do not trust can be checked against a
  public key held somewhere else. `lib/builds/cli.ts verify --public-key <hex>`
  does exactly that and needs no private key to run.

It is **not** a claim about the build's contents. It says *Scruple published
this measurement*, not *the bytes behind it are good*.

Publishing **fails closed** without a key. Ingest does not, and the asymmetry
is deliberate: refusing to publish suppresses nothing, because no artifact
exists yet that would go unrecorded. Refusing at ingest destroys evidence of an
artifact that already exists. One rule — *fail closed where failing closed
costs evidence nothing.*

There is deliberately **no HTTP publish route**. Publication would have to be
authorised by something, and the only thing that legitimately authorises it is
possession of the signing key — which a route would have to be handed over the
wire or hold ambiently for any caller carrying a tenant scope. No `/v2` scope
is the right credential for this, and a tenant must never be able to publish a
build. `app/api/v2/builds/**` is read-only; the write path is local and
key-bearing.

---

## 3. The ingest decision: an unknown build is RECORDED, not rejected

The obvious reading of §4.3 is that a leaf claiming a build we never shipped
should be refused. **It should not**, and the reasons are the ones §4.2 already
accepted for counter gaps.

**1 · Refusing the leaf does not un-produce the artifact.** The bytes exist;
the component is telling us about them. A rejection turns *"an artifact
witnessed under an unrecognised build"* — a flagged, dated, investigable fact —
into *"an artifact with nothing said about it"*, which is the hole H-4 exists
to close. §4.2 made this exact trade already: "if a gap invalidated the leaves
around it, suppressing one event would become a way to attack the vendor's
whole record."

**2 · It would hand that attack to anyone who can move a byte.** If an unknown
measurement were fatal, changing one byte of the component would make every
subsequent leaf vanish *with the server's cooperation*. The party best placed
to do that is the tenant, whom §1 already treats as the adversary. Rejection
would build a suppression primitive and call it strictness.

**3 · The false positive has no recovery path in the vendor's hands.** A
legitimate early adopter mid-rollout, a hotfix that beat the registry entry, a
measurement taken over a source tree the vendor patched for their own
environment — each is an honest component that would go dark mid-run and
present as a component bug. That is the failure mode §10 C-5 describes for
provisioning, reproduced on the hot path where it costs leaves.

**4 · Rejection is an enumeration oracle.** Accept-or-refuse on a claimed
string tells a caller which measurements we have published. Recording answers
identically either way.

**5 · And it buys nothing against the attacker it is aimed at.** A modified
build can claim a *published* measurement string exactly as easily as an
unpublished one — §4.3's own stated limit. A rejection rule therefore filters
precisely one population: the honest and unrecognised. The security is in the
MAC, not the string.

### What "recorded" has to mean for this to be honest

An unknown build must be **visible**, never silently fine. Three places, none
of them a log line:

| Where | What it says |
|---|---|
| `VerifyOk.build_status` | on the ingest result, every submission |
| `component_events.build_status` | durable, per event, written at ingest and never rewritten later |
| `GET /api/v2/builds/unrecognised` | tenant-scoped report of every event whose build was not `published` |

`build_status` is `published` · `withdrawn` · `superseded` · `unpublished` ·
`undeclared` · `unchecked`, and it is **NULL** for rows written before this
migration. NULL is not `unpublished`: it means the registry was not consulted,
and a question that was never asked is not an answer. Same reasoning migration
043 gives for `component_verified`.

`unchecked` is the registry's **own** failure, named rather than swallowed.
`checkClaimedBuild()` runs inside `verifySubmission()`, before the transaction;
if it could throw, a fault on our side would 500 a submission that MACed
correctly, turning our outage into the vendor's lost leaf — the precise failure
this work order exists to refuse. So it cannot throw, and a check that could not
run is not recorded as a check that passed. §7's rule for probes, applied to
ourselves: **an inconclusive is never a pass.**

The status is evaluated **as of the event's `verified_at`** and written down
there and then. A build published later does not retro-bless an earlier leaf,
and a build withdrawn later does not retro-condemn one. Both are asserted by
test.

---

## 4. The honest limit — registry plus key, not registry alone

**A modified build can claim any measurement string, including a published
one.** Nothing in this registry changes that, and it is stated here rather
than discovered later.

What a modified build cannot do is **produce a valid MAC without the injected
key**. The registry and the key schedule are one piece of work:

- Where the vendor has attestable compute, **the IK is sealed to the
  measurement**. A build that is not the measured one cannot unseal the key,
  so it cannot MAC, so its claim never reaches the registry check at all. The
  leaf is `verified` (H-5), and *that* is the pairing worth describing to a
  vendor.
- Where they do not, the IK is software-protected and the binding between key
  and build is **assertion**. The leaf is `passthrough` and says so. The
  registry check still catches the honest mistake — a component running a
  build we never shipped — and still does not catch the dishonest one.

So the registry is one half of a pair. On its own it detects **unrecognised**
builds, not **modified** ones. Every external surface says this in those
words: `GET /api/v2/builds` carries the sentence in its response body, so a
vendor reading the list cannot read it as more than it is.

---

## 5. What §4.3 may now claim

The original sentence was:

> Because we publish the component, the server can check the claimed build is
> one we shipped — **the first time P1 is checkable at ingest rather than
> attested.**

**Narrowed, and true in the narrowed form.** What the registry makes true is
that *an unrecognised build is detectable at ingest and recorded on the
event*. What it does not make true, in the strong reading the old sentence
invited, is that the server can check the **running** build is the one we
shipped: it checks the **claimed string**, and a modified build can claim a
published one. §4.3 now says the narrower thing, and §10 C-4 records the
change.

The difference matters in a vendor conversation, which is the whole reason
this work order existed. "We check your build against a registry of what we
published, and an unrecognised build shows up on your reconciliation report"
is a sentence we can defend. "We can tell whether you are running the build we
shipped" is one we cannot, unless the IK is sealed to the measurement — and
then it is the seal doing the work, not the registry.

---

## 6. Operating it

```bash
# once, per environment — the key never enters the database
node --import tsx lib/builds/cli.ts keygen

# measure and publish the component from its own source tree
node --import tsx lib/builds/cli.ts publish \
  --component scruple-capture --version 0.1.0 \
  --measure-src services/scruple-capture/src

node --import tsx lib/builds/cli.ts list
node --import tsx lib/builds/cli.ts status sha256:… --at 2026-08-05T00:00:00Z
node --import tsx lib/builds/cli.ts withdraw sha256:… --reason "CVE-…"
node --import tsx lib/builds/cli.ts supersede sha256:… --by sha256:…

# re-check every signature in the registry — needs only the PUBLIC key
node --import tsx lib/builds/cli.ts verify --public-key <hex>
```

`--measure-src` imports `services/scruple-capture/src/build-measurement.ts`
dynamically. `lib/` does not take a static dependency on the component it
measures: the server holds the BDK and by §4.1 the component never does, and
that boundary is worth keeping visible in the import graph.

### One caveat about the measurement itself

`build-measurement.ts` digests the component's **source tree** — "what a
component can measure about itself with no help", in its own words — and its
own header says a real deployment SHOULD prefer the image digest the vendor's
registry publishes. `measurement_kind` records which of the two an entry is,
because the two produce incomparable strings for the same artifact and a
registry that conflated them would be worse than none. A component that ships
compiled rather than as source measures the compiled tree, which is a
different string again; whoever publishes an entry is stating which artifact
they measured, and the column is where that statement lives.
