# One entity holds truth, and it is never a vendor

_2026-08-31, founder direction. LOAD-BEARING._

## The principle

**There is exactly one authoritative record, Scruple holds it, and a vendor
never does.**

Not "primarily", not "by default". One.

## The distinction I had collapsed

I had been treating *"who audits?"* as an open architectural question. It is
not. Two different things wear that name:

| | Can vary | Never varies |
|---|---|---|
| **Who performs the review** — reads the architecture, runs the probes, raises findings | ✅ us now; a third party later; the vendor themselves under a self-run-and-submit model | |
| **Who holds the record** — the leaf chain, the seal registry, the findings, the mark | | ❌ **always Scruple** |

CNCF is the precedent: vendors run the conformance suite themselves and submit
results, and **the Linux Foundation still holds the record and the mark.** The
labour is delegable. The custody of truth is not.

So the open question is about **labour and independence**, and it cannot reach
the architecture. A third-party assessor submits findings *into our record*;
they do not keep their own.

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
