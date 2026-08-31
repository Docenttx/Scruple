# One entity holds truth, and it is never a vendor

_2026-08-31, founder direction. LOAD-BEARING._

## The principle

**There is exactly one authoritative record, Scruple holds it, and a vendor
never does.**

Not "primarily", not "by default". One.

## Scruple audits. That is what a standard is.

**Nobody audits but Scruple.** Not "us now, a third party later" — that was an
overreach in the first draft of this document and it is corrected here.

A standard body that lets someone else grant conformance does not have a
standard; it has a framework. Two auditors means two interpretations, and the
binary compliance claim (§5) stops meaning one thing — which is exactly what the
trademark clause forbidding implied gradations exists to prevent.

Every mature programme keeps the **authority** central even where it delegates
**labour**: EMVCo accredits labs but EMVCo approves; NIST accredits testing labs
but CMVP validates; PCI SSC accredits QSAs but owns the standard and the marks.
Delegation is an accreditation programme — a large, later, separate thing that
requires the authority to already be unambiguous. **It is not an option to hold
open at the start; holding it open is what makes it never arrive.**

### The correction this forces to my earlier recommendation

I had recommended the CNCF self-run-and-submit shape from
`oss-study/sonobuoy-conformance.md`. **That was the wrong import and I carried it
further than the evidence supported.**

Kubernetes conformance is self-certified because every claim it certifies is
**functional and re-runnable by anyone** — lying is discoverable by any end user
repeating the run. Our properties are not that. `ARCHITECTURE_DECIDES.md` is
explicit that the defence against an undeclared surface is *someone reading the
architecture at audit*. **A model whose central safeguard is a human looking
cannot delegate the looking to the party being looked at.**

## What follows for the tooling

- **Phase 2 tooling is ours**, built for our assessors. It is not a distributable
  artifact a stranger runs and self-certifies with.
- **What a vendor receives is integration tooling and a submission path** — not
  the audit tool. That materially simplifies the vendor package.
- The vendor still runs probes during Phase 1 to find their own problems early.
  **Running the probes is not auditing**; the audit is the reading, the finding,
  and the record.

## Signing a declaration is not holding truth

This settles the DSSE signer question more precisely than "the vendor signs."

- **The vendor signs their predicate** — their declaration about their own
  configuration. That makes them **accountable for a statement**, on the record,
  with their name on it.
- **Scruple signs and holds the leaf** — the record of what happened, and the
  record that the declaration was made.

Two signatures, two roles, **one truth-holder**. A vendor signature is
*testimony*; it is not custody. And the reason the vendor signs rather than us
is unchanged: if we signed their posture claim we would be vouching for a
configuration we cannot see.

## Checked against what we have built

Every authoritative store already sits on our side. Recorded so a future change
has to argue against it rather than drift past it:

- `lib/seal/registry.ts` — our database, our Ed25519 signer, no HTTP write route
- `lib/builds/registry.ts` — same shape, same custody
- the ratchet — server-side verification, BDK never leaves our boundary
- lifecycle and drift events — signed and appended by us, vendor-*declared* but
  not vendor-held
- `component_events`, gap records, silence — ours

The vendor-side queue (`packages/scruple-host-sdk/queue.py`) is the one thing
that looks like an exception and is not: it is a **transport buffer**, not a
record. Its counters are spent against our chain and reconciled by us, which is
precisely why the ratchet's counter travels in the clear.

## Why this holds rather than being a preference

An evidence system whose record can be held by the party being measured has no
claim to make. It is the same reason the capture component's key is derived from
a base key the component never sees, and the same reason a vendor cannot state
their own posture — `resolvePlacement` **computes** it.

**Every mechanism in the canon already assumes this. It should be written
down.**

## The one consequence to watch

An auditor who cannot write to our record has nowhere to put a finding — so if
review is ever delegated, the submission path is the thing to design carefully.
It must accept findings **without** accepting record custody: a third party
proposes, and the record is ours to write.
