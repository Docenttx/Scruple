# Two phases, two toolchains

_2026-08-30, founder direction. Refines `INTEGRATION_LIFECYCLE.md`, which
flattened the audit into a single state._

## The shape

**Phase 1 — Integration.** The vendor builds against the skeleton/SDK and gets
their system talking to the witness server. Developer-facing.

**Phase 2 — Audit.** We grade the built thing end to end. Auditor-facing. It
produces **findings**, because it will. Then remediation — bugs, user friction,
things that need adjusting — and then a **final post-remediation audit**.

The lifecycle states become:

```
integrating → audit → remediating → re-audit → sealed
                ↑__________________________|
                     (findings reopen)
```

`resealing` re-enters this, and **where it re-enters depends on the materiality
class** — which the estate already computes. A `material` change re-enters at
audit; an exhausted drift budget is a narrower check. That is EMV's delta
approval, and it is why materiality was worth defining precisely.

## Why the toolchains must be different

`INTEGRATION_LIFECYCLE.md` had one state, `verifying`, doing both jobs. They
have different users and opposite failure modes:

| | Phase 1 tools | Phase 2 tools |
|---|---|---|
| User | the vendor's engineers | an assessor (us, or eventually a third party) |
| Optimised for | fast feedback, obvious next step | reproducibility, adversarial rigour |
| Output | "this call is wrong, here is why" | a signed evidence bundle and findings |
| Runs | constantly, locally | at defined moments, from the tenant position |
| Failure mode if confused | a compliance gate that feels like a linter | a linter that gets mistaken for an audit |

Conflating them is how an audit becomes something a vendor runs until it goes
green — which is not an audit.

## Findings must be first-class objects

The grader currently emits a **grade**. Phase 2 needs it to emit **findings you
can track and close**: raised → accepted or disputed → remediated → verified.
Common Criteria calls them Observation Reports, PCI calls them gaps, a pentest
calls them findings; every mature programme has the object because remediation
needs something to point at.

A disputed finding is a legitimate outcome and must be representable. Sometimes
the assessor is wrong — and this week produced several examples of a grader
reporting a fix that had not happened and a probe passing on a hash collision.

## The re-audit is not "re-run the failed probe"

Two properties it must have, both standard:

1. **Verify the fix.** The specific finding is closed on evidence.
2. **Regression.** The fix did not break something that passed. A remediation
   that closes one finding and silently opens another is the normal way a
   compliance programme rots.

## The trap this phase introduces — and it is the important one

**During remediation, the vendor has read the findings.** That is a strictly
stronger adversary than one who has not, and it is the only point in the
lifecycle where the party being measured knows exactly which measurement is
about to be repeated, and is under commercial pressure to make it pass.

Every grader weakness found this week is what a motivated vendor would find in
that window:

- a **string-anchored** check that a rename defeats (the retired secret
  surviving in a comment, reporting a fix that never happened);
- **probe 5 passing on a hash collision** — the same 1×1 PNG down both paths, so
  the filesystem leaf satisfied a WebSocket claim;
- **probe 6 recording three `400 malformed` as a clean pass**, indistinguishable
  from a deployment with no replay defence at all;
- **a probe run of one deployment satisfying another's P2** — every fact true,
  conclusion false.

**So Phase 2 tooling must be built assuming the reader is hostile and informed.**
Anchor on properties, never spellings. Make inconclusive a distinct outcome that
is never a pass. Require negative controls. Bind a run to its subject. All four
already exist because they were found the hard way — but they were found by us
looking, and in Phase 2 the vendor is looking too, at a report we handed them.

## Open, and it is a business decision rather than an engineering one

**Who audits?** Today: us. That does not scale and is not independent. The
options are the ones every programme faces — first-party (fast, weak), an
accredited third party (independent, slow, expensive to stand up), or the CNCF
shape of self-run plus submission plus a reproducibility-triggered revocation
clause. `oss-study/sonobuoy-conformance.md` recommends the third for a small
team, with PCI's two-tier split for the parts a self-test cannot reach.

Deciding this changes what Phase 2 tooling is *for*: our console, or an artifact
a stranger runs and submits.
