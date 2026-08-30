# `scruple-vendor-baseline` — the predicate, and the split it lives in

**Status:** Design, implemented. `lib/envelope/`, `test/v2/envelope.test.ts`.
**Version:** predicate `v1` · statement `v1` · 2026-08-30 · WO-2 of `WO-SERIES-CANON-AS-FLOOR.md`
**Predicate type:** `https://scruple.ai/attestation/vendor-baseline/v1`
**Binds:** `PLACEMENT_AND_SURFACES.md` (every axis name), `SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md` §2 (P1–P8) and §4 (the platform-attestation envelope), migration `041_components.sql` (component identity)
**Consumes:** `oss-study/in-toto.md` §3.1 and §6 (why the split), `oss-study/SYNTHESIS.md` §5 (why we implement rather than vendor), `lib/leaf/registry.yaml` (the leaf's shape)

---

## 1. The problem this closes

A leaf is a flat object. Everything a Scruple integration asserts — the
hashes, the chain position, the seals — sits in one shape, and until this WO
the compliance posture had nowhere to go except into that same shape.

The cost is not aesthetic. It is that **the compliance vocabulary and the
signing machinery could not move separately.** Adding a ninth property,
renaming an enforcement mechanism, or versioning the placement model would
have changed the thing that gets signed, which means changing what every
consumer must understand *in order to check a signature whose meaning it does
not care about*. A transparency log, a retention service, a receipt renderer
and a third-party verifier all have to parse a producer's arbitrary schema
just to answer "is this authentic".

in-toto solved this and said why (`oss-study/in-toto.md` §3.1). Their
envelope spec carries the rule as a negative requirement — a verifier
"SHOULD NOT require the verifier to parse the payload before verifying" —
and their versioning policy reads the payoff off it: a new predicate type is
a **PATCH** release, because "none of these changes affects the semantics of
the core spec".

## 2. The four layers

```
┌─ envelope ────────────────────────────────────────────── lib/envelope/dsse.ts
│  { payloadType, payload (base64), signatures[] }
│  Knows: bytes, signatures. Knows nothing else.
│
│  ┌─ statement ───────────────────────────────── lib/envelope/statement.ts
│  │  { _type, subject[], predicateType, predicate }
│  │  Knows: what this is about. Treats predicateType as an opaque string.
│  │
│  │  ┌─ subject ──────────────────────────────────────────────────────┐
│  │  │  { name, digest: {sha256}, leaf }   ← the witness leaf, VERBATIM │
│  │  └────────────────────────────────────────────────────────────────┘
│  │
│  │  ┌─ predicate ─────────────────────────── lib/envelope/predicate.ts
│  │  │  scruple-vendor-baseline: placement, enforcement, attestation,
│  │  │  surfaces, component identity, P1–P8.
│  │  │  Knows: compliance. Knows nothing about signing.
│  │  └──────────────────────────────────────────────────────────────────
```

`lib/envelope/attest.ts` is the only file that knows both halves, and is
therefore the only file that has to change when either side versions.
`lib/envelope/pae.ts` and `lib/envelope/dsse.ts` cannot import the predicate,
the statement or `lib/capture/surface.ts` — `test/v2/envelope.test.ts` scans
their source and fails if they do. That test is the split; the diagram is
just a picture of it.

### 2.1 What versions independently, and what that buys

| Layer | Version carried in | Bumping it changes |
|---|---|---|
| Envelope | `"DSSEv1"` inside PAE — fixed by the DSSE spec | nothing of ours |
| Payload media type | `application/vnd.scruple.statement+json` — **deliberately stable** | — |
| Statement | `_type: https://scruple.ai/attestation/Statement/v1` | nothing below it |
| Predicate | `predicateType: .../vendor-baseline/v1` and `predicate_version` | nothing above it |

The media type is stable **across statement versions on purpose**, copying
in-toto: the version lives in `_type`, inside the payload, so a consumer that
only checks signatures never has to learn that the statement moved. The PAE
input it length-prefixes is described the same way before and after.

`test/v2/envelope.test.ts` §6 proves both directions mechanically: bump the
predicate and the statement `_type`, the `payloadType` and the leaf bytes are
identical; bump the statement and the `predicateType` and the predicate bytes
are identical. Neither bump touches PAE, and the DSSE specification's own
vector is re-asserted after both to say so.

## 3. The subject is the leaf, and the digest is not a new hash

The leaf rides in the subject **verbatim** — not normalized, not re-keyed,
not canonicalized. `leafSubject()` puts the caller's object in;
`leafFromSubject()` returns the same object; the round-trip test asserts
`JSON.stringify` equality, not merely deep equality, so key order counts. The
envelope wraps. It does not reshape.

Integrity of the leaf comes from the DSSE signature over the whole statement.
That is precisely why nothing here hashes the leaf — and why nothing here
*may*. `digest.sha256` is the leaf's own **`output_hash`**: sha256 of the raw
output bytes, per `lib/leaf/registry.yaml`, which is the one digest a third
party holding the artifact can actually re-derive, and which is what
in-toto's subject digest means. Inventing a "hash of the leaf object" would
create a second preimage for something that already has one, and
`lib/leaf/hashes.ts` opens with why that is the expensive kind of mistake.

**The subject binding states no field list.** It reads `output_hash` and
`witness_id` through `resolveField()`, so a leaf spelled `content_hash` (the
submit and storage surfaces) and one spelled `output_hash` (the canonical
record) both bind, and this layer never learns there are two names. That
rename is in the registry so callers do not have to know which of the two
they were handed; using it here is the first time that has paid off.

A leaf with no `output_hash` is **refused**, not given a synthetic digest.
The registry marks the field `required` on three surfaces; a leaf without one
is not a weaker subject, it is an unidentifiable one.

## 4. The predicate

```jsonc
{
  "predicate_version": 1,

  // migration 041 `components`, spelled the way that table spells it.
  "component": {
    "component_id": "<uuid>",          // the HKDF salt for the IK, not a label
    "tenant_id": "<vendor>",
    "build_measurement": "sha256:…"    // null until the component declares one
  },

  // PLACEMENT_AND_SURFACES.md §4. `effective` is DERIVED, never declared.
  "placement": {
    "declared":    "server-library | sidecar-gate | attested-client | unattested-client",
    "enforcement": "no-tenant-code | isolated-namespace | host-enforced-signature | none",
    "effective":   "<resolvePlacement(declared, enforcement)>",
    "honoured":    true,
    "reason":      "<why it resolved that way>"
  },

  // TWO AXES. See §5 — they are not the same field.
  "attestation": {
    "provider":  "none | amd-sev-snp | intel-tdx | aws-nitro-enclave |
                  gcp-confidential-space | azure-attestation-service |
                  nvidia-h100-cc | tpm-2.0-quote | <other>",   // P7
    "quote_ref": "<stable reference to the attestation, or null>",  // P7
    "verifier_reference": "<required when provider has no built-in verifier>", // P8
    "outcome":   "verified | passthrough | none"               // §5 of the axes doc
  },

  // PLACEMENT_AND_SURFACES.md §3 and §3.1, as data.
  "surfaces": [{
    "name":     "comfyui-http-gate",
    "surface":  "network-gate | filesystem-watch | in-process-callback | host-api-callback",
    "fidelity": "as-delivered | as-written | induced",
    "hooks":    ["graph.execute", "artifact.produced"],
    "induced_artifact_ref": "<REQUIRED when fidelity is 'induced'>"
  }],

  // P1 and P3 are derived. The other six are declarations.
  "properties": {
    "p1": "holds | conditional | fails",   // DERIVED
    "p2": "…", "p4": "…", "p5": "…", "p6": "…", "p7": "…", "p8": "…",
    "p3": "holds | conditional | fails"    // DERIVED
  },

  "leaf_status": "verified | passthrough | null",  // DERIVED; null = no leaf may issue
  "can_claim":   true,                             // DERIVED
  "conditions":  ["…what must be evidenced for each 'conditional'…"]
}
```

Every enum above is imported from `lib/capture/surface.ts`, not restated.
`vendorBaselinePredicateSchema()` emits the JSON Schema **from those same
constants**, and a test asserts the emitted enums are identical to the
constants — so a parallel vocabulary cannot grow here without failing.

### 4.1 A predicate cannot grade itself

`PLACEMENT_AND_SURFACES.md` DEFECT-1 records what happens when it can: a host
that declares its own placement assigns itself its own tier, and Fusion and
Blender both get the plugin grade for being plugins.

So `buildVendorBaselinePredicate()` **computes** `placement.effective` (via
`resolvePlacement`) and `p1`, `p3`, `leaf_status`, `can_claim`, `conditions`
(via `assuranceFor`), and `validateVendorBaselinePredicate()` **recomputes**
all of them on a predicate that arrived from somewhere else and refuses one
whose stated posture disagrees. A forged posture is a schema error, not a
judgement call.

The other six properties are declarations, because no function of two enums
can decide whether a baseline covers the whole capture path (P2) or whether
`principal_id` is server-derived (P4). They are declared so that WO-9's
self-grade harness has something to contradict — and DEFECT-2 stands: **a
well-formed declaration is what to probe, never evidence that probing would
pass.**

### 4.2 `unattested-client` is valid and refused

A predicate at `unattested-client` passes validation with `can_claim: false`
and `leaf_status: null`. That is deliberate and it is §4.1 of the axes doc:
the fourth placement exists so the model can *say no*, and a shape the model
cannot express is a shape it cannot refuse. Making it a schema error would
delete the refusal.

The test pins the hostile case from §7.6 specifically — a browser-JS
configuration holding a genuine root-verified quote — because that is the one
an implementer would be tempted to improve.

## 5. Where the vocabulary actually disagreed

The instruction for this WO was to use `PLACEMENT_AND_SURFACES.md`'s
vocabulary verbatim and to report rather than smooth over any place it
conflicts with the rest of the canon. Four places, in descending order of how
much they can hurt.

### 5.1 `none` means two different things, and they collide in one object

`SCRUPLE_INTEGRATION_REQUIREMENTS_v1.md` P7 defines
`attestation.provider: none` as **"this compute environment provides no
hardware attestation, and P8 is not applicable"**. `PLACEMENT_AND_SURFACES.md`
§5 defines `AttestationOutcome: 'none'` as **"the leaf carries no envelope"**
— and it is careful to add that H-5 *rejects* `attestation_type: 'none'`, so
`none` there means absent, not null.

Two axes, one spelling, and they land in the same `attestation` object. A
configuration on SEV-SNP hardware whose leaves carry nothing is
`provider: 'amd-sev-snp'` with `outcome: 'none'` — a **P8 failure** — and
collapsing the two into one field makes that state unrepresentable rather
than invalid, which is the worse of the two outcomes.

**Resolved by carrying both** and cross-checking them in the validator:
provider `none` requires outcome `none`, and any other provider requires an
outcome that is not `none`. Not renamed: renaming either would desynchronise
this predicate from a shipped document or from a shipped column.

### 5.2 `attestation_type` (§4.1) vs `attestation.provider` (P7) vs `attestation_provider` (041)

The same enumerated set — `amd-sev-snp`, `nvidia-h100-cc`, … — is called
`attestation_type` on the per-leaf envelope (§4.1), `attestation.provider` on
the baseline manifest (P7), and `attestation_provider` in migration 041's
`components` table. Three names, one vocabulary.

The predicate uses **`provider`**, because a predicate is a baseline-posture
document and P7 is the property it carries. This is recorded rather than
reconciled, on the same reasoning `lib/leaf/registry.yaml` gives for
`content_hash`/`output_hash`: a live wire field is not renamed for tidiness.
**If the leaf-field registry ever grows an attestation group, these three
belong in it as aliases** — that is where drift of this exact shape is
supposed to live now, and it is the natural second consumer of WO-1's
`resolveField`.

### 5.3 Migration 041 defines `verified`/`passthrough` by their consequence

`041_components.sql` says of `attestation_status`: *"'verified' means the IK
was sealed to an attested measurement, so a modified build could not unseal
it."*

That is not what the value means; it is what the value **implies**.
`PLACEMENT_AND_SURFACES.md` §5 defines `verified` as an outcome of H-5's
`dispatch()` — chained to the vendor root, nonce matched the leaf preimage,
inside the freshness window, all three — and *then* §5.1 step 3 derives "P3
holds, IK sealed to the build measurement" from it. Reading 041's comment as
the definition would let a component whose IK is sealed but whose quote never
chained to a root call itself `verified`.

Nothing is broken today, because the same word is being used for the same
value. It is recorded because the derivation is one step long and 041 dropped
the step.

### 5.4 Fidelity still has no per-leaf home

`PLACEMENT_AND_SURFACES.md` §10 says fidelity "should be a registry field
(WO-1) so a receipt can say whether the reader can re-derive the hash", and
notes it was left out because the registry was another agent's file. WO-1 has
landed and `lib/leaf/registry.yaml` has no fidelity field.

The predicate carries fidelity **per declared surface**, which is the right
granularity for a *configuration* and the wrong one for an *observation*: a
`host-api-callback` surface can be any of the three fidelities (§3.1 says so),
so a leaf produced by one still cannot say which of them applied to it. The
gap is narrower than it was and it is not closed. Naming it here rather than
letting the predicate look like it closed it.

## 6. What was implemented, and what was pointedly not copied

`pae.ts` implements the DSSE Pre-Authentication Encoding from
`secure-systems-lab/dsse/protocol.md`:

```
PAE(type, body) = "DSSEv1" + SP + LEN(type) + SP + type + SP + LEN(body) + SP + body
```

with `SP` one 0x20 byte and `LEN` the shortest decimal form of the **byte**
length. Not one line is derived from anyone's source.
`oss-study/SYNTHESIS.md` §5 is the reason: every DSSE and in-toto
implementation in the study set is Apache-2.0 with an explicit patent grant
and a termination-on-litigation clause, and that has to be weighed against
Docent's own patent work *before* code is copied rather than after. A format
is free to implement; an implementation is not free to copy. `/data/oss-study`
holds go-witness's Go PAE, and it was read for the one-line formula it
documents in a comment and for nothing else.

### 6.1 How PAE was validated

`protocol.md` carries one worked example, and it is a good one: a payload
type, a body, the resulting PAE string, an ECDSA P-256 key as decimal
`X`/`Y`/`d`, and a base64 signature produced by an implementation that is not
ours. The test verifies **that signature over our PAE bytes**. It only
verifies if our bytes are byte-identical to the spec's, which makes it an
external check of `pae.ts` and `dsse.ts` together rather than a check of our
own expectations. A hand-written expected string could be wrong in the same
way the implementation is wrong; this cannot.

Node's ECDSA is not RFC 6979 deterministic, so the spec's signature *bytes*
are not reproducible here and are not asserted. Verifiability is the claim
and verifiability is what is asserted.

The four ordinary ways to get PAE wrong — LEN in UTF-16 code units, a padded
LEN, encoding the body before length-prefixing it, a wrong separator — are
pinned by **our own** vectors, labelled as ours in the test file, because the
spec supplies only the one. The most important of them is the injectivity
pair: without length prefixes `("a", "b c")` and `("a b", "c")` produce the
same bytes, so a signature over one is a signature over the other, and that
is the entire reason PAE exists.

### 6.2 One rule taken straight from the spec

`envelope.md` requires that an implementation "MUST ensure that the same
payload bytes that are verified are the ones sent to the application layer",
and must not re-parse the envelope after verification. So `verifyEnvelope()`
**returns** the verified bytes and `parseStatement()` takes a `Buffer` rather
than an envelope. A caller that verifies and then decodes again has written
the bug the rule exists to prevent, and the API is shaped so the correct path
is the shorter one. The escape hatch is named `decodeUnverifiedPayload()`,
which is meant to be uncomfortable at a call site.

## 7. What this deliberately does not do

- **It does not adopt in-toto's layout/step/threshold model.**
  `oss-study/in-toto.md` §5 is the argument: a layout expresses "which named
  step ran, signed by whom", and P1–P8 almost entirely ask "what was the
  measured party *able* to do". Their reference implementation is, in our
  vocabulary, a textbook P1/P3 failure — the functionary is the runtime
  boundary and the key custodian at once — and their own code says so.
- **It does not claim in-toto's type URIs.** `_type` is
  `https://scruple.ai/attestation/Statement/v1`, not
  `https://in-toto.io/Statement/v1`. Claiming theirs would assert conformance
  to a spec we have not tested against their verifier, and their verifier
  could not check our predicate anyway — ITE-10/11, the mechanism for binding
  a non-Link predicate, is still Draft.
- **It does not define a bundle.** in-toto's fourth layer (JSON-Lines, many
  statements) has no consumer yet. It is a format, it will be trivial when
  something needs it, and shipping an unused container is how a skeleton
  acquires weight it never earns back.
- **It is not wired into `/api/v2/witness`.** WO-2's acceptance is the split
  and the round-trip. The route that emits envelopes is WO-6's
  `server-library` path, and the component that signs them is WO-3's. Adding
  a call site now would mean choosing a key custody story ahead of H-4 §4,
  which is the one decision this file must not make.
- **`ecdsaP256Signer` is not a custody story.** It exists so tests and the
  reference path have a signer at all. P3 custody is the component's.
