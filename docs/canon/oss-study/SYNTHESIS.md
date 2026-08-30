# What five OSS projects say about the Scruple vendor problem

_2026-08-30. Synthesis of `in-toto.md`, `witness.md`, `opentelemetry.md`,
`opa-policy.md`, `sonobuoy-conformance.md` (2,048 lines of study behind this)._

## Bottom line

Five projects, briefed independently, converge on one answer: **nobody solves
the problem that the party being measured runs the measuring code.** in-toto's
trust model is possession of a key and says so in its own source. TestifySec's
witness signs in the same process on the same host as the thing it measures.
OTel's conformance matrix is glyphs a vendor types. OPA can't reach it because
policy engines evaluate documents and the document is the vendor's self-portrait.
Sonobuoy's certification works precisely because everything it certifies is
functional and re-runnable by anyone.

That is not a gap in our reading. **It is the thing Scruple is for**, and after
this study I'd say it out loud in the vendor material rather than treating P1/P3
as hygiene we're behind on.

The transferable answer to the irreducible residue is CNCF's, and it isn't
technical: don't verify the unverifiable — **make the claim falsifiable by
anyone, publish the probe that falsifies it, and attach revocation with a cure
window.** The mark is the enforcement mechanism, not the test suite.

---

## 1. The convergence

| Project | Does it solve "measured party runs the measuring code"? | Their actual mitigation |
|---|---|---|
| in-toto | **No.** `verifylib.py:1513-1521` — trust *is* key possession, explicitly indifferent to environment attributes | None. Different threat model: semi-trusted build farms, non-repudiation |
| TestifySec witness | **No.** `witness run` collects and signs in one process on the host being measured | **Organizational** — run on CI the measured party doesn't control; Fulcio keyless bound to CI OIDC |
| OpenTelemetry | n/a — but its compliance matrix has *zero* enforcement (`.github/scripts/compliance_matrix.py` renders YAML to Markdown) | Social. PR review. Appropriate when worst case is a missing dashboard field |
| OPA / Gatekeeper | **Structurally cannot.** Policy engines evaluate documents | Swap the evidence source to independently-issued records (the Sigstore trick) |
| Sonobuoy / CNCF | **Sidesteps it.** Every certified claim is functional and independently re-runnable | Signed participation form + **reproducibility-triggered revocation** |

in-toto's nearest gesture at the problem — the SCAI predicate, which can carry a
hardware quote — is documented as a labeled **slot** for third-party evidence,
not a verifier of it (`scai.md:79-82`). Binding it into verification is draft
spec (ITE-10/11) with no verifier implementation. The ecosystem has named the
problem and not built it.

## 2. Resolving the two decidability tables

The OPA and Sonobuoy studies produced tables that appear to disagree — OPA
calls P6 undecidable, Sonobuoy calls it testable. They don't disagree; they
answered different questions. Neither asked the third question, which is ours.

| | Decidable from a **submitted document**? (OPA) | Provable by a **suite the vendor runs**? (Sonobuoy) | **Enforceable by us at ingest?** |
|---|---|---|---|
| **P1** boundary integrity | No | Partial — a tamper probe converts part of it | **No** |
| **P2** baseline coverage | No | Yes for *matching*; no for *coverage* | Partial — require a manifest hash matching a registered baseline |
| **P3** key custody | Partial — if evidence is the KMS policy, not the claim | No | No |
| **P4** principal identity | Yes — if from an IdP token | Yes | **Yes** — refuse principals not bound to an issued token |
| **P5** immutable chain | Yes, structurally | Yes | **Yes — we own the log.** Refuse mutation; it is not a vendor property |
| **P6** zero-content | No | Yes, for exercised paths | **Yes, on our channel — we are the receiver** |
| **P7** attestation declaration | Yes | Yes | **Yes** |
| **P8** import discipline | Yes — the thing checked is someone else's signature | Yes | **Yes** |

The third column is the one neither study computed, and it is the strongest
position we hold: **we are the receiving end.** P5 and P6-on-the-witnessed-channel
aren't things we ask a vendor to promise — they're things we enforce unilaterally
by refusing traffic. Four of eight properties (P4, P5, P7, P8) move from
"vendor attests" to "we reject non-conforming input" the moment we stop
accepting self-described identity and start requiring independently-issued
records.

**The residue after all three columns: P1, P3, and the coverage half of P2.**
That is exactly the measured-party problem, and exactly what no project above
solves. It is three items, not eight. That is a much smaller and more honest
surface than "vendors must satisfy P1–P8 and we hope."

## 3. The mechanism for the residue

CNCF's answer, which is the most transferable thing in the whole study:

- A signed participation form — a **human commitment**, not a test result.
- Any end user may re-run the tests. **Failure to reproduce triggers a 30-day
  cure-or-remove-the-mark notice.** The claim is made falsifiable by third
  parties, and the consequence is contractual.
- The mark is **binary, time-boxed, and revocable.** Re-certification is forced
  by protocol version bumps and material product change.
- Trademark terms **forbid implying gradations** ("do not say... more certified
  than another") and forbid implying endorsement. Directly reusable liability
  boundary for a Scruple mark, and it enforces Standard §5's binary compliance
  as a *legal* property rather than a technical aspiration.
- Trademark ownership sits with the Linux Foundation, distinct from CNCF, the
  reviewing body. Worth copying if IP ownership ever separates from review
  authority.

For the two irreducible items, the study recommends **PCI-DSS's two-tier model**
over SOC 2 or Common Criteria: self-test for the testable items, and for P1/P3
a signed attestation plus published reproducible probes plus the cure/revoke
window. SOC 2 and CC need accredited auditors we cannot stand up.

The Kubernetes suite has a documented adversarial promotion process
(`framework.It()` → `framework.ConformanceIt()`, two weeks flake-free, a review
board) and the tests are generated from RFC-2119 doc-comments. **The suite
literally is the spec.** That is the discipline that stops P1–P8 drifting into
prose nobody can check — and our own Studio grade is the proof it's needed.

## 4. What to build, in order

**Take:**
1. **The statement/predicate/envelope split** (in-toto) — publish a
   `scruple-vendor-baseline` predicate over a DSSE-style envelope so P1–P8
   version independently of signing.
2. **The API/SDK split** (OTel) — `scruple-api` with no network capability,
   `scruple-sdk` wrapping `http.py`. The seam already exists: only 4 of our 13
   modules touch the network, and an AST test already enforces it by
   inspection. Packaging should enforce it instead. Port the `Once()`-guarded
   `ProxyTracer` late-binding swap, not just the no-op principle.
3. **The Attestor interface + RunType phases** (witness) as our capture-plugin
   contract. Caveat: witness's attestors are compiled in via Go `init()` — they
   only *feel* pluggable. Don't oversell hot-pluggability.
4. **Reason-sets, the ConstraintTemplate/Constraint split, audit-over-existing-
   state** (OPA) — reimplemented in TypeScript. And **OPA's bundle-signing
   format verbatim** (`.signatures.json`, JWTs per file, documented
   canonicalization): it answers "which policy version produced this verdict"
   the first time a vendor disputes one.
5. **The conformance loop and the trademark terms** (CNCF) — including the
   revocation clause, which is the only mechanism here that addresses P1/P3.
6. **A leaf-field registry with `deprecated.renamed_to`** (OTel semconv). It
   would already have caught a live inconsistency: `server.js:661` returns wire
   field `signer_surrogate` while `:234-236,626` write column
   `leaf_signer_surrogate`.

**Don't take:**
- in-toto's layout/step/threshold/artifact-rule machinery. It verifies *what
  ran*, authenticated by key possession. P1–P8 mostly ask what the environment
  *permitted*, which layouts have no field for.
- Rego as a runtime. Two reasons, neither of them the TS/Python cost: the
  distribution problem it solves isn't ours (**the vendor never runs our
  policy** — our witness server evaluates it), and Rego's niche is checking
  predicate content *after* provenance is established, which is downstream of
  P1/P2/P6.
- OTel's compliance matrix as a model. Self-declared glyphs are fine when the
  worst case is a missing dashboard attribute; a false `+` here means we sign a
  lie. Cells must point at machine-generated baseline evidence.

## 5. Licensing

All five are Apache-2.0 with explicit patent grants. Studying and reimplementing
carries no obligation; **vendoring does**, and should be checked against Docent's
patent work before any code is copied rather than after. Nothing in the "take"
list above requires vendoring — the format-level items (DSSE envelope shape,
`.signatures.json`) are specifications we can implement independently.

## 6. Open question this study sharpens

Whether training-on-a-user-controlled-pod is a shape Scruple supports at all.
Every project studied that touches this shape resolves it the same way: **move
the measurement out of the measured party's boundary, or accept that trust is
organizational.** Canvas v2 already made that move once. Kohya has not, and
`STUDIO_P1-P8_GRADE.md` records what that costs. The three honest options remain
(a) not supportable and the standard says so; (b) supportable only via capture
outside the pod; (c) supportable at a declared lower tier that is visibly not
the full claim.
