# Response to the C2PA Conformance Program — L2 Remediation + Sample Fixes

**From:** Shaun Hargadine, on behalf of Docent LLC (dba Docent Technologies)
**Date:** 2026-07-18
**Re:** C2PA Generator Product Conformance Review nonconformities (your 2026-07-16 email)
**Intake record ID:** `019f5856-bff8-7f57-a879-80594a6fb3fe`

---

Dear Scott,

Thanks for the detailed review. Every item in your 2026-07-16 email has been
addressed. Everything below is in the attached bundle:

**`scruple-c2pa-conformance-response-2026-07-18.zip`**

## Confirmations

- **Target assurance:** Level 2, remediated per your Conclusion & Next Steps.
- **Legal entity:** Docent LLC (Delaware), dba Docent Technologies.
- **Product role:** Generator Product (Distributed class), unchanged from the
  first submission.

## Item-by-item

### Item 1 — L2 nonconformity (6.3.2 + 6.4.2, OS patch recency)

**Remediated by architectural change**, per your Required Remediation clause.

Signer CVMs now run in an OCI Instance Pool with a **60-day maximum instance
age** enforced by an OCI Function on a 6-hour schedule. No in-service Signer
CVM can exceed the window because the fleet manager physically replaces it,
provisioning from the current CI-verified golden image. The 30-day margin
inside the 90-day requirement absorbs schedule latency + drain time.

Every signed manifest now carries an `ai.scruple.signer-runtime.v1` assertion
binding the signing instance's OCID, image OCID, creation timestamp, computed
age at sign time, and configured max-age policy — so any verifier can
independently confirm the signer was within the max-age window at signing.

A secondary in-guest guardrail on the Signer itself refuses to sign if the
running CVM has aged past the policy, so a Function outage cannot silently
allow an over-age instance to keep signing.

Design + evidence in:

- `security-architecture-delta/01-GPSA-delta.md` — full architectural
  description, actuator wiring, C.2.3 / C.2.4 replacement text
- `security-architecture-delta/cvm-provision-delta.md` — updated operational
  runbook
- `deploy/oci-signer-rotation/terraform/` — Instance Configuration, Instance
  Pool, Function, Scheduler, IAM policies
- `deploy/oci-signer-rotation/function/rotate_signer_cvms.py` — rotation
  Function code
- `services/c2pa-signer/signer_runtime.py` — in-guest age-guard + runtime
  assertion emitter
- `Part-2-Runtime-Assertion-Sample/scruple-runtime-assertion-sample.png` —
  illustrative signed asset carrying the runtime assertion (real production
  values populated from IMDS at sign time)

### Item 2 — `c2pa.created` missing `digitalSourceType`

**Fixed.** The evidence-sample builder and the production runtime signer
both migrated from raw `c2pa.actions.v2` assertion injection to c2pa-python
0.89's first-class `Builder.set_intent(intent, digital_source_type)` +
`Builder.add_action(...)` API. Every c2pa.created action now carries
`digitalSourceType: http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia`
(the accurate marker for Scruple's canonical GenAI workload).

### Item 3a — c2pa.* assertions inside the `created` block

**Fixed via `builder.created_assertion_labels` settings.** Confirmed the
root cause per c2pa-rs source (`sdk/src/claim.rs::claim_assertion_type`)
and the CAI opensource docs on created-vs-gathered assertions: c2pa-rs
v2 defaults non-hash assertions to `gathered_assertions` unless the
label appears in `builder.created_assertion_labels`. Our previous
manifest (even after the API migration) had `c2pa.actions.v2` and
`c2pa.thumbnail.claim` in `gathered_assertions` — the wrong bucket per
C2PA v2 spec, which was exactly what your screenshot pointed at.

We now set the following via `c2pa.load_settings`:

```
builder.created_assertion_labels = [
    "c2pa.actions",
    "c2pa.thumbnail.claim",
    "c2pa.thumbnail.ingredient",
    "c2pa.ingredient"
]
```

Regenerated samples verified via `Reader.detailed_json()`:

```
claim.created_assertions:
  - self#jumbf=c2pa.assertions/c2pa.thumbnail.claim
  - self#jumbf=c2pa.assertions/c2pa.actions.v2
  - self#jumbf=c2pa.assertions/c2pa.hash.data
claim.gathered_assertions:  (empty)
```

For samples with an ingredient (Validate.output), the ingredient
assertions also land in `created_assertions` correctly.

**Additional fix in the same pass — softwareAgent object shape.** Per
CAI opensource docs, `softwareAgent` should be the `ClaimGeneratorInfo`
object `{"name": "Scruple", "version": "0.1"}` rather than a plain
string `"Scruple/0.1"`. Regenerated samples use the object shape
consistently.

### Item 3b — inception action must be first

**Fixed.** The SDK's `set_intent` emits the inception action as the first
entry in the actions array. Supplementary actions added via `add_action`
follow in insertion order after the inception action.

### Item 4 — .mov Validate.output validation mismatch

**Fixed as a side effect of the same API migration.** The pre-fix raw
manifest injection produced malformed action assertions inside the QuickTime
container. The regenerated `.mov` Validate.output sample now validates
`state=Valid` with clean `assertion.bmffHash.match`,
`assertion.hashedURI.match` (actions + ingredient), and `claimSignature.validated`.

### Item 5 — validate against your CA / TSA trust list corpus

**Done.** All six samples from `Google_Samples/` were ingested and validated
by our reference validator. Per-sample JSON reports plus a summary README are
in the bundle at:

- `trust-validation-results/README.md` — summary + findings
- `trust-validation-results/*.validation.json` — per-sample validation JSON

**Notable finding in your corpus:** three of six samples (`sample-X-ingredientN.jpg`,
`sample-X-ingredientN.m4a`, `sample-X-ingredientM.mp4`) fail internal integrity
validation with `signingCredential.expired`. The Google Pixel signing certificate
chain used on those three appears to have aged out. Our validator correctly
flags this and refuses to consider the manifests valid. The three server-side-
signed samples (Google Core TSA) validate cleanly. Flagging back for your
awareness — you may want the Pixel-side chain refreshed.

## Where each artifact lives in the zip

| Item | Location |
|---|---|
| L2 remediation design | `security-architecture-delta/01-GPSA-delta.md` |
| Updated runbook | `security-architecture-delta/cvm-provision-delta.md` |
| Rotation stack (Terraform + Function) | `deploy/oci-signer-rotation/` |
| In-guest actuator + runtime assertion emitter | `services/c2pa-signer/signer_runtime.py` |
| Signer runtime wiring | `services/c2pa-signer/sign.py`, `services/c2pa-signer/build_evidence_bundle.py`, `lib/c2pa/signAsset.ts` |
| Regenerated Generate.output samples (15 MIMEs) | `Part-1-Media-Samples/Generate.output.<mime>/` |
| Regenerated Raw.input samples (20 MIMEs) | `Part-1-Media-Samples/Raw.input.<mime>/` |
| Regenerated Validate.output samples (18 MIMEs) | `Part-1-Media-Samples/Validate.output.<mime>/` |
| Runtime-assertion sample (illustrative) | `Part-2-Runtime-Assertion-Sample/` |
| Reviewer trust-list corpus (as received) | `reviewer-samples/` |
| Trust-list validation report | `trust-validation-results/` |
| Reviewer's assessment PDF (for reference) | `C2PA_Generator_Product_Conformance_Review.pdf` |

## Documented gaps (unchanged from prior submission)

Three MIMEs still cannot be signed by the c2pa-python 0.89 wrapper used by
our bundle producer (`application/pdf`, `application/x-pytorch`). Raw inputs
are provided in `Raw.input.<mime>/` and each affected `Generate.output`
/ `Validate.output` folder contains a `NOT_SUPPORTED.txt` explaining the
wrapper edge. Signed samples will follow when the wrapper exposes them.

## Optional secondary L2 mechanism (not implemented; available on request)

The GPSA delta describes an alternative or supplementary path via Oracle OS
Management Hub (OSMH) that would report OS patch age directly rather than
substituting instance age. We did not implement this because the Instance
Pool rotation path satisfies the requirement architecturally without adding
an in-guest management agent to the TOE. If you prefer a direct patch-age
measurement in addition to the architectural rotation, we can add OSMH
self-check as Actuator 3 in a subsequent update.

## Next steps

Ready for the second review pass. Happy to walk any of the above through a
video-conference review at your convenience.

Best regards,

**Shaun Hargadine**
Docent LLC (dba Docent Technologies)

- Contact: `scruple@docentechs.com`
- Public product site: `scruple.ai`
