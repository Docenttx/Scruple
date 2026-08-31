# Priorities

_2026-08-31, founder. Supersedes the WO-series orderings, which were sequenced
by dependency rather than by what the business needs._

1. **Produce an end-to-end demo on request** — from C2PA or the EU AI Office.
2. **Be able to start pitching vendors.**
3. **A slow plugin rollout: full-production Fusion first, then Adobe, then
   anything with a native plugin surface.**

**Blender is not a priority.** The canonical-form prototype
(`research/blend-canonical/`) stays a preserved prototype; the empty-claim
finding stands and is not being acted on.

---

## What P1 actually requires — and the call it reverses

**"On request" is the whole specification.** It means rehearsed and repeatable,
not heroic. A demo that takes a week of preparation fails the requirement even
if it eventually works.

**This reverses my own advice on the CVM.** I argued it could stay down because
real key custody is only needed "when there is an external claim." **A demo for
C2PA or the EU AI Office *is* the external claim** — and the audience is the one
population that will read an OCID. Our surrogate is deliberately honest about
being a surrogate: `protectionMode: SOFTWARE`, `.surrogate.` in every OCID, and
it refuses to fake `/dev/sev-guest`. Correct for building, visibly wrong for
this.

So P1 needs, in order:

1. **Redeploy the witness.** Production still runs the 2026-07-16 build **without
   H-1**, so leaves are HMAC-sealed rather than ECDSA-signed by the TOE key.
   §2's "witnessed through the same signing key" would still be aspirational in
   front of the people it was written for. No spend, no CVM.
2. **Bring the CVM up.** ~$135/month, already priced. **Test the unverified thing
   first** (`L2_FLOOR.md` §5): the cloud-init binding the signer key to the
   SEV-SNP measurement is first-boot-only, and whether attestation survives a
   stop/start is **unknown**. If it does not, the whole restart plan fails — a
   correctness question wearing a cost question's clothes, and it must not be
   discovered during a demo.
3. **One sealed, demonstrable integration**, end to end: capture → leaf → C2PA
   manifest → third-party verification.

## What we could show today, honestly

A C2PA-signed asset with a real manifest — signing works, restored after two
independent breaks — and witness leaves from a server whose build predates H-1,
with a key held by an acknowledged surrogate. **Demonstrable, and the custody
story is visibly incomplete to exactly the audience that would ask.**

## P1 and P2 share a critical path

Both need **one integration that actually grades compliant end to end**, and the
only candidate is Studio. A vendor pitch that cannot show a working compliant
integration is a slide deck.

Studio's remaining gap is small and known: canvas has **no registered
deployment**, ingests through `lib/iterations/ingest.ts` rather than
`/v2/witness`, and so carries `seal_state = NULL`. It needs registering, binding
to the sealed path, a probe run from its own tenant position, and a seal.

**That work also discharges `STUDIO_IS_AN_EXEMPLAR.md`** — canvas stops being a
parallel implementation and becomes a consumer, which is the same fix.

## What P2 needs beyond that

Reduced by `ONE_TRUTH_HOLDER.md`: since **Scruple is the only auditor**, a
vendor receives **integration tooling and a submission path — not the audit
tool.** So the vendor package is the SDK, the `server-library` quickstart (38
lines, demo green), the class declaration, and honest per-class claim wording.

## P3 — Fusion, and what the study says it costs

Not started, and third. What full production means, from
`custody-study/fusion.md`:

- **Confirm whether per-edit witnessing has ever fired.** It is registered as
  `app.commandTerminated` inside a bare `except: pass`, and `commandTerminated`
  is a `UserInterface` event. One live session settles it. **Until then, treat
  Fusion's per-edit record as unproven.**
- **Bind the leaf to `versionId`/`versionNumber`.** The cloud version sequence is
  the only part that genuinely resists the user — Autodesk's own API has zero
  `DELETE` operations — and it is the part our leaf does not reference.
- **Stop using `timeline.count` as the tripwire.** Parameter edits, reorders and
  suppressions all leave the count unchanged.
- **Fusion Automation API** (GA 2025-05-19) is the only route that retires the
  `induced` fidelity problem, since `DataFile.download` will not hand an add-in
  the bytes it saved.

Adobe follows, where the ground is already surveyed: **nothing in Adobe's stack
says anything about the interval between two saves**, and the `ActionDescriptor`
event stream that could is neither persisted nor signed.

## Sequence

**Witness redeploy → CVM up (test stop/start first) → Studio sealed → demo
rehearsed → vendor package → Fusion.**

The demo is also the best test we have: it is the first thing that exercises
capture, leaf, seal, signing and verification as one path rather than as
separately-passing suites.
