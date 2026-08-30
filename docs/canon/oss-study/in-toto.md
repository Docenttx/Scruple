# OSS study: in-toto — layouts, links, attestations

_Study date 2026-08-30. Sources: `in-toto/in-toto` @ `e352b43` (2026-08-27),
`in-toto/attestation` @ `2dcd055` (2026-08-24), `in-toto/ITE` @ `a6bf0ab`
(2025-02-17). All three cloned successfully to `/data/oss-study/`; no
WebFetch fallback was needed._

**License:** all three repos are Apache-2.0 (`in-toto`: NYU 2018;
`attestation`: in-toto Developers 2021; `ITE`: NYU 2020). Apache-2.0 §3 is
an explicit, irrevocable patent grant scoped to each contributor's own
contribution, with a termination-on-litigation clause. Studying and
copying *ideas/shapes* is unencumbered either way; vendoring code would
pull in that grant and its termination clause, which is a real
distinction only if we ship their code, not if we describe their model.

## Bottom line

Steal the four-layer split (predicate / statement / envelope / bundle) —
publish our own P1–P8 as a `scruple-vendor-baseline` predicate type with a
stable `predicateType` URI, sign it with DSSE, and let the schema evolve
independently of the signature mechanism. Steal the artifact-rule idea in
spirit (a small closed grammar for "this input came from that output") for
chaining witness events, not the rule syntax itself. Do **not** adopt the
in-toto layout/step/threshold model as our compliance mechanism — it
verifies *what ran*, and P1–P8 are almost entirely about *what the
environment permits the vendor to do*, which is a claim in-toto's own
reference implementation cannot check either: it trusts the functionary's
signing key precisely the way our rejection criteria say a vendor
integration must not be trusted. Their own answer to that gap (SCAI, the
hardware-attestation predicate) is a labeled envelope for evidence, not a
verifier — it is still in draft-tier spec status for layout binding
(ITE-10/11), and even finished, it only relocates the trust problem to
"whoever verifies the enclave quote," which for us has to be Scruple's own
witness server, not the vendor's layout.

---

## 1. The layout format

### 1.1 What a layout expresses

`in_toto/models/layout.py` defines three classes: `Layout`, `Step`
(subclass of `SupplyChainItem`), `Inspection` (also a `SupplyChainItem`).

A `Layout` (`layout.py:64-116`) has fields `steps` (list of `Step`),
`inspect` (list of `Inspection`), `keys` (dict of `keyid -> pubkey`),
`expires`, `readme`. It carries no `principal`/environment concept — its
only notion of "who" is a public key.

A `Step` (`layout.py:564-658`, inheriting `name`, `expected_materials`,
`expected_products` from `SupplyChainItem` at `layout.py:477-561`) has:

```python
_type = attr.ib()             # "step"
pubkeys = attr.ib()           # list of authorized functionary keyids
expected_command = attr.ib()  # list, e.g. ["make", "install"]
threshold = attr.ib()         # int, default 1
```

So "step N must be performed by principal X" is: `pubkeys: [keyid_X]` on
the `Step`, where `keyid_X` resolves against `Layout.keys[keyid_X]`
(a public key blob, not an identity — see §1.3). "Consuming artifacts
matching pattern A, producing artifacts matching pattern B" is:
`expected_materials`/`expected_products`, each a list of *artifact rules*
(§1.2) evaluated against a **link** (§2), not against the layout directly
— the layout only states the rule, the link is the evidence the rule is
checked against.

### 1.2 Artifact rule grammar (quoted)

Grammar and evaluator live in `in_toto/rulelib.py` (parser,
`unpack_rule`/`pack_rule`, lines 43–353) and `in_toto/verifylib.py`
(evaluator, `verify_*_rule` functions, lines 645–986). From
`README.md:41-48` (the human-readable form) and `rulelib.py:50-58`
(the parser's authoritative docstring):

```
MATCH <pattern> [IN <source-path-prefix>] WITH (MATERIALS|PRODUCTS)
    [IN <destination-path-prefix>] FROM <step>,
CREATE <pattern>,
DELETE <pattern>,
MODIFY <pattern>,
ALLOW <pattern>,
DISALLOW <pattern>,
REQUIRE <file>
```

`rulelib.py:29-40` splits these into `GENERIC_RULES =
{create, modify, delete, allow, disallow, require}` (2-token, just a
verb and an `fnmatch` pattern) and `COMPLEX_RULES = {match}` (up to
10 tokens, four accepted arities depending on which optional `IN` clauses
are present — `rulelib.py:131-176`). Patterns are Python `fnmatch`
globs (`README.md:47`), not regex.

Evaluation order matters and is queue-based. `verify_item_rules`
(`verifylib.py:1014-1155`) builds an `artifacts_queue` = union of a
step's materials or products, then walks the rule list *in the order
authored*, each rule consuming (removing) matched paths from the queue —
`verify_match_rule` (`verifylib.py:645-767`) removes paths it matches
against another step's recorded materials/products;
`verify_create_rule`/`verify_delete_rule`/`verify_modify_rule`
(`verifylib.py:768-888`) check a path's presence/absence across the
before/after material-product diff and consume it; `verify_allow_rule`
(`verifylib.py:889-917`) just consumes matches without asserting
anything; `verify_disallow_rule` (`verifylib.py:918-953`) raises
`RuleVerificationError` if anything in the queue still matches after
prior rules ran; `verify_require_rule` (`verifylib.py:954-986`) asserts
one exact filename is present, unconsumed. The closing convention,
stated in `README.md:49`: **default-allow** — "artifacts are allowed to
exist if not explicitly disallowed," so `DISALLOW *` as the last rule is
the idiom for a closed allowlist. This is the opposite default of P6's
posture (Scruple's ingest schema hard-rejects unrecognized shapes; the
`ALLOW`/`DISALLOW` idiom in in-toto is opt-out, ours is opt-in).

### 1.3 Key binding

Purely a keyid → pubkey lookup, no identity layer. `Step.pubkeys` is a
list of hex keyids (`layout.py:642-650`, `_validate_pubkeys`); the
layout's `keys` dict (`layout.py:81-83`, `add_functionary_key` at
`layout.py:283-299`) maps keyid → public key material (PEM/GPG). At
verify time, `verify_link_signature_thresholds`
(`verifylib.py:402-558`) walks each step's submitted links, and for each
link's signing keyid checks it against `step.pubkeys`, including an
explicit main-key/subkey delegation rule (`verifylib.py:410-413,
443-496`: "If the layout's key store lists a (master) key K, with a
subkey K', then K' is authorized implicitly ... The inverse is not
true"). There is no notion of key *rotation*, *revocation*, or
*expiration* tied to real-world identity — the code says so explicitly
at `verifylib.py:1513-1521`: *"in-toto's verification workflow directly
uses the key for verifying signatures. It does not communicate with
external sources of information for specific attributes about keys ...
in-toto does not rely on the creation time, revocation status, and usage
flags for PGP keys. To revoke ... the supply chain owner must sign a new
layout."* Trust is 100% "possession of the private key," full stop —
there is no separate principal-identity claim comparable to our P4.

### 1.4 `threshold`, `expected_command`, `inspections`

- **`threshold`** (`Step.threshold`, default 1): minimum count of
  *distinct authorized functionaries* (by main key, not by link file)
  who must submit a validly-signed, mutually-agreeing link for that step
  before verification proceeds — `verify_link_signature_thresholds`
  (counts unique `used_main_keyids`, `verifylib.py:541-551`) and
  `verify_threshold_constraints` (`verifylib.py:1190-1279`, checks the
  *content* of those links agrees, not just the count). This is
  m-of-n co-signing for a single step, not a distributed-consensus
  primitive — it does not span steps.
- **`expected_command`**: declared per step, compared against the link's
  recorded `command` in `verify_command_alignment`
  (`verifylib.py:561-596`). This is explicitly a **soft/non-fatal**
  check: *"Command alignment is a weak guarantee. Because a functionary
  can easily alias commands"* (`verifylib.py:568-570`) — mismatch only
  logs `LOG.warning` (`verifylib.py:590-595`), it never raises. This is
  the one place stock in-toto's "binary" verification is knowingly not
  binary, and the maintainers say so in the code.
- **`inspections`**: a *separate* list on the layout
  (`Layout.inspect`), each an `Inspection` object (`layout.py:660-725`)
  carrying its own `run` command and its own material/product rules.
  Inspections execute **client-side, at verify time**, after all step
  links are already validated (`in_toto_verify` step 10,
  `verifylib.py:1624-1627`, `run_all_inspections` at
  `verifylib.py:178-259`) — e.g. "unpack the final tarball and diff it
  against the last step's product." They are the verifier's own
  re-derivation, not functionary-submitted evidence, and their rules can
  reference any prior step's or inspection's links.

### 1.5 How verification fails — is it binary?

`in_toto_verify` (`verifylib.py:1484-1642`) runs eleven ordered stages
(signatures → expiration → parameter substitution → load links → link
signature/threshold → sublayouts → command alignment (soft) → threshold
constraints → step rules → run inspections → inspection rules) and
**raises** a typed exception the first time a hard check fails
(`SignatureVerificationError`, `LayoutExpiredError`, `LinkNotFoundError`,
`ThresholdVerificationError`, `RuleVerificationError`,
`BadReturnValueError` — enumerated in the docstring,
`verifylib.py:1550-1571`). If it returns instead of raising, the summary
line is literal: *"The software product passed all verification"*
(`verifylib.py:1636-1637`). So: **binary in outcome** (pass = function
returns a summary `Link`; fail = exception, no partial-credit score,
no numeric grade) **with one explicitly acknowledged soft rule**
(command alignment, §1.4) that can silently diverge from the layout
without failing verification.

## 2. Link metadata

`in_toto/models/link.py:35-177`. Fields, one per attr:

- `_type` = `"link"` (constant, validated)
- `name` — matches the layout `Step.name` it provides evidence for
- `materials` — `{path: {hash_algo: hex_digest, ...}, ...}`, artifacts
  present *before* the command ran
- `products` — same shape, *after*
- `byproducts` — opaque dict, conventionally `stdout`/`stderr`/
  `return-value` (`link.py:69-71`)
- `command` — list, the argv actually executed
- `environment` — opaque dict, *optional*, e.g. env vars / workdir
  (`link.py:73-80`) — **not validated, not required, not part of the
  security model**; it is diagnostic metadata a functionary may or may
  not choose to record, and no verifier reasons over it.

Produced by `in_toto_run` (`in_toto/runlib.py:406-...`): hashes
`material_list` before executing `link_cmd_args` as a local subprocess
(`execute_link`, `runlib.py:293-349`), hashes `product_list` after, signs
the result with whatever key/GPG identity is passed in, writes
`STEP-NAME.KEYID-PREFIX.link` (`link.py:29`). **Chaining to the next
step is not a field on the link itself** — there is no "previous link
hash" pointer. The chain is reconstructed entirely by the *layout's*
`MATCH ... FROM <step>` rules at verify time: step B's
`expected_materials` names step A by `dest_name` and the verifier looks
up A's already-verified link to compare hashes
(`verify_match_rule`, `verifylib.py:645-767`, resolves `dest_name`
against the `links` dict passed in). This is a meaningful structural
choice: the **layout**, not the **link**, owns graph topology. A link on
its own is just a signed hash manifest for one named step; it carries no
memory of its position in a chain.

## 3. Attestation framework (`in-toto/attestation`)

### 3.1 The four layers and why they're separate

`spec/README.md:9-15`: *"It has four layers that are independent but
designed to work together: Predicate ... Statement ... Envelope ...
Bundle."* Concretely:

- **Predicate** (`spec/v1/predicate.md`): `{"predicateType": "<URI>",
  "predicate": {...arbitrary...}}` — just a type tag plus a
  schema-defined-elsewhere blob. `predicate.md:16-19`: *"Users are
  expected to choose an existing predicate type ... or develop a new one
  if no existing one satisfies. New predicate types MAY be vetted by the
  in-toto attestation maintainers."*
- **Statement** (`spec/v1/statement.md:8-21`): binds a predicate to a
  `subject` array of `{name, digest}` pairs (subjects matched **purely
  by digest**, `statement.md:52-53`) and a `predicateType` URI. This is
  the only layer that knows "what artifact is this about."
- **Envelope** (`spec/v1/envelope.md:1-16`): "handling serialization and
  authentication (via digital signatures)." Recommended format is DSSE
  v1.0; alternatives are allowed if they meet ITE-5's requirements —
  multiple signatures per envelope, an authenticated `payloadType`,
  a `keyid` hint, and explicitly: *"SHOULD NOT require the verifier to
  parse the payload before verifying"* (`envelope.md:8-15`).
- **Bundle** (`spec/v1/bundle.md`): a JSON-Lines container to ship many
  signed Statements together.

**Why split at all** — the payoff, read off the versioning policy in
`spec/README.md:26-53`: predicate schemas and the envelope/statement
core version *independently*. A new predicate type is a PATCH release
that "does not affect the semantics of the core spec" (example given
verbatim: v1.0.2 "incorporates ... a new predicate type ... None of
these changes affects the semantics of the core spec"). A generic
consumer (a signature verifier, a transparency log, a policy engine that
only checks "is this signed by an authorized key over this subject
digest") never has to understand any predicate schema to do its job —
`envelope.md`'s explicit non-requirement that the verifier parse the
payload before verifying signatures is the mechanical expression of
that. A single blob (predicate + signature fused) would force every
consumer, including ones that only care about authenticity, to parse
every producer's arbitrary schema just to check a signature. This is
directly the shape Scruple wants for P7/P8: the **envelope** (DSSE-style
signature over a payload) is provider-agnostic; the **predicate**
(`platform_attestation`, the hardware-attestation payload) is where
provider-specific shapes (SEV-SNP report vs. Nitro doc vs. TPM quote)
live without touching how anything is signed or verified for
authenticity.

### 3.2 The `link` predicate — old model recast

`spec/predicates/link.md:1-52` defines
`https://in-toto.io/attestation/link/v0.3` as "a generic attestation
type with a schema isomorphic to \[the pre-attestation in-toto Link\]...
Depending on the context, a more specific predicate type such as
\[Provenance\] may be more appropriate." Structurally: `subject` takes
over the role of `products`, `predicate.materials` becomes a list of
`ResourceDescriptor`s instead of a bare hash-dict, `predicate.name`/
`command`/`byproducts`/`environment` carry over unchanged. This confirms
the migration path is additive (old Link shape becomes one predicate
type among many), not a breaking rewrite.

### 3.3 SCAI — the closest thing to an environment-attestation predicate

`spec/predicates/scai.md` (`predicateType`
`https://in-toto.io/attestation/scai/v0.3`) is explicitly about the
class of claim P1/P7 need: *"A producer seeks to assert certain
properties about its underlying compute platform ... Examples ...
include properties like secure boot enablement or trusted execution
enablement. Since these types of attributes are often accompanied by an
attestation document, these hardware attestations serve as evidence for
the asserted attributes"* (`scai.md:38-46`). Schema
(`scai.md:97-108`):

```jsonc
{
  "predicateType": "https://in-toto.io/attestation/scai/v0.3",
  "predicate": {
    "attributes": [{
      "attribute": "<ATTRIBUTE>",
      "target": { /* ResourceDescriptor */ },      // optional
      "conditions": { /* object */ },               // optional
      "evidence": { /* ResourceDescriptor */ }       // optional
    }],
    "producer": { /* ResourceDescriptor */ }        // optional
  }
}
```

Worked example, "Attestation for build on Intel(R) SGX hardware"
(`scai.md:315-343`), sets `attribute: "VALID_ENCLAVE"` and points
`evidence` at a `downloadLocation` with `mediaType:
"application/x.sgx.dcap1.14+json"` — **an opaque URI/hash reference to
an externally-generated hardware quote**, not a mechanism SCAI itself
verifies. SCAI's own docstring (`scai.md:79-82`) is explicit about what
it does *not* do: *"we emphasize that this predicate does not dictate
the types of attributes that can be attested, nor does it prescribe any
format to the evidence for an assertion."* SCAI is a labeled slot to
carry a claim plus a pointer to third-party evidence; verifying that the
SGX quote is genuine, current, and matches the enclave measurement it
claims to is entirely outside SCAI's — and the attestation framework's
— scope. That verification burden falls on whoever consumes the
predicate.

## 4. The ITE process

`in-toto-ITE/README.md` lists 3 Accepted+Draft categories: **Standards
Track** (spec changes), **Informational** (non-binding guidance),
**Process** (project governance). `ITE/1/README.adoc` (Status: Active)
specifies the format, modeled openly on Python's PEP process — numbered
documents, a named Sponsor, an `ITE-editors` GitHub group that assigns
numbers and manages status transitions, revision history kept as the
historical record of the design rationale (`ITE/1/README.adoc:69-71`).

Concretely, how they avoid breaking existing implementations while
extending the spec, evidenced by two shipped ITEs:

- **ITE-5** ("Disassociate signature envelope specification from
  in-toto", Accepted) introduces DSSE as a pluggable envelope and
  explicitly carries a **transition period**: `ITE/5/README.adoc:187-190`
  *"Implementations should continue to support old-style envelope as
  well as new-style envelopes during the transition period."* Old and
  new coexist by capability negotiation, not a version cutover.
- **ITE-10** ("Supporting Contextual in-toto Attestations in Layouts",
  status **Draft**) is the mechanism that would let a `Step` bind to a
  non-Link predicate type (e.g. SCAI) — and its own motivation section
  says plainly this is *not yet true of v1.0*: *"in-toto v1.0 layouts
  and artifact rules cannot be used to verify artifacts recorded in
  ITE-6 attestations"* (`ITE/10/README.adoc:44-46`). **ITE-11**
  ("Verifying Attributes in in-toto Attestations") is also Draft. So as
  of the code we read, `verifylib.py`'s eleven-stage verifier
  understands `Link`-shaped evidence only — hooking a `Layout.Step` to a
  SCAI predicate and having the reference `in_toto_verify` actually
  check it is not implemented, it is a proposal.

Versioning discipline for the spec itself follows SemVer
(`spec/README.md:26-53`): predicate additions are PATCH, backward-compatible
core changes are MINOR, breaking core changes are MAJOR and get a new
`spec/vN` directory plus a new `_type` URI (`Statement/v2`) so old and
new statements are trivially distinguishable by inspection, never by
guessing.

---

## 5. Mapping to Scruple

**Is a layout the right shape for P1–P8, or is it expressing something
different?** Something different, and precisely: a layout expresses
*"which named step ran, who signed for it, and did its declared inputs
and outputs chain to the neighboring steps."* Every one of its
mechanisms — `pubkeys`/`threshold` (§1.3–1.4), artifact rules (§1.2),
`expected_command` (soft, §1.4) — answers "what happened," authenticated
by whoever held a key. P1–P8 mostly do not ask "what happened"; they ask
"what was the witnessed party *able* to do" — P1 (can the witnessed
party modify the capture code), P2 (does the baseline cover the whole
capture path, not just one command), P3 (can the witnessed party reach
the signing key), P4 (can the witnessed party forge their own
principal_id). A layout has no field for "the environment this step ran
in was constrained such that the functionary could not tamper with the
step's own measuring code" — it can name a key, but it cannot say
anything about whether that key's *custody* meets a bar. This is not
in-toto being underspecified for our case; it is a boundary they drew on
purpose (§1.3's quote: trust is entirely "possession of the key," and
revocation/attributes about the key are explicitly out of scope).

**Does in-toto have any mechanism for the second kind of constraint (how
the environment is built), or is the environment assumed / attested
out-of-band?** Out-of-band, and only partially: the base spec assumes
it — nothing in `Layout`, `Step`, or `Link` asserts anything about the
functionary's runtime. The **attestation framework**'s SCAI predicate
(§3.3) is the one artifact in the whole ecosystem aimed at this gap, and
it is explicitly a *carrier*, not a *checker*: it lets a producer attach
a `VALID_ENCLAVE`-style claim plus a pointer to a hardware quote, but
verifying that quote (checking it against Intel's/AMD's/AWS's root of
trust, checking freshness, checking the measurement matches the claimed
binary) is left entirely to whatever consumes the SCAI predicate — the
spec says so in its own words (`scai.md:79-82`, quoted above). And even
that carrier is not wired into layout verification yet: binding a
`Step` to a SCAI (or any non-Link) predicate is still Draft-status
ITE-10/11 (§4), unimplemented in the `verifylib.py` we read. So: no
working mechanism today, and the closest designed mechanism explicitly
defers the actual proof to something outside in-toto's scope — which is
exactly our own posture (P7/P8: the platform declares an
`attestation.provider`, and Scruple's server, not the vendor's own
layout, is the thing that must verify the hardware evidence).

**The crux — what does in-toto do about "the party being measured runs
the measuring code"?** Nothing, and the reference implementation is
frank about it rather than silent. `in_toto_run` (`runlib.py:406-...`)
executes the step's command as a **local subprocess in the functionary's
own environment** and signs the resulting link with a key the
functionary supplies to the same CLI invocation
(`gpg_keyid`/`signer` params, `runlib.py:412-424`). The functionary
*is* the runtime boundary and *is* the key custodian in one. The
project's own docstring names this as the entire trust model rather
than a gap to be closed: *"in-toto's verification workflow directly uses
the key for verifying signatures. It does not communicate with external
sources of information ... It is the supply chain owner's responsibility
to consider such attributes before ... adding \[a key\] to the layout"*
(`verifylib.py:1513-1521`). Put in our vocabulary: **stock in-toto's own
reference implementation is a textbook P1/P3 failure** — the code that
computes the hash and the key that signs the result both live inside
the boundary of the party being measured, which is precisely the
"unacceptable boundary" our own rejection criteria name (`SCRUPLE_
INTEGRATION_REQUIREMENTS_v1.md` §5: *"witness calls only when present.
Fails P1"*; *"the user can inspect the request, extract the key ...
Fails P1 and P3"*). This is not a criticism of in-toto's design — their
threat model is a different one (a project owner constraining
*known, semi-trusted* build-farm operators, with the key as the
non-repudiation anchor, not an adversarial platform trying to fool an
outside verifier). It does mean their layout/link/verify machinery
cannot be adopted as-is to solve *our* problem, because it was never
built to solve it — our problem is closer to remote attestation
(SEV-SNP/TDX/Nitro measured-boot style proofs) than to supply-chain
step-sequencing, and their own answer for that (SCAI) is a slot for
someone else's remote-attestation output, not a remote-attestation
mechanism itself.

**Could a Scruple vendor integration be expressed as an in-toto layout
we publish and they verify against? Sketch.** Mechanically yes for the
*shape* of "which capture step ran, with which artifacts, signed by
which key" — no for the parts that matter most (P1/P3/P7 environment
claims), which would have to live in a bolted-on SCAI-style predicate
that in-toto's own verifier does not natively check (§4). A sketch, using
real in-toto layout syntax for what it *can* express and inline comments
for what it cannot:

```jsonc
{
  "_type": "layout",
  "expires": "2027-01-01T00:00:00Z",
  "readme": "Scruple vendor baseline: capture -> submit witness leaf.",
  "keys": {
    "<vendor-baseline-keyid>": { "...": "vendor's baseline-signing pubkey" }
  },
  "steps": [
    {
      "_type": "step",
      "name": "capture-and-witness",
      "pubkeys": ["<vendor-baseline-keyid>"],
      "threshold": 1,
      "expected_command": [],
      // in-toto CAN express: this named step must be attested by a key
      // the vendor's baseline manifest identifies.
      "expected_materials": [
        ["DISALLOW", "*"]
        // in-toto has no rule for "materials MUST NOT include payload
        // bytes" (P6) beyond path-pattern allow/disallow -- it cannot
        // express a content-shape constraint, only a path constraint.
      ],
      "expected_products": [
        ["MATCH", "witness-leaf.json", "WITH", "PRODUCTS", "FROM", "capture-and-witness"],
        ["DISALLOW", "*"]
      ]
    }
  ],
  "inspect": []
  // No field anywhere in this schema for:
  //   P1  "the runtime boundary the end user does not control"
  //   P3  "the key material's custody / secret-manager handle"
  //   P4  "principal_id derivation is server-side, not user-suppliable"
  //   P7  "attestation.provider" + a live hardware quote reference
  // These would require a companion SCAI-shaped predicate attached
  // out-of-band (ITE-10/11, still Draft) -- and even then, SCAI only
  // carries a pointer to evidence; Scruple's own server, not the
  // vendor's layout verifier, would still have to be the party that
  // checks the quote is genuine and current.
}
```

The honest reading of this sketch: everything a layout *can* express
here (step name, signer, artifact presence/absence) is already covered
by our simpler existing mechanisms (baseline manifest + witness leaf
schema + HMAC/signature check). The parts that would be genuinely new
value — machine-checkable P1/P3/P7 — are exactly the parts in-toto
cannot express either, so importing the layout format buys us a more
complicated syntax for what we already do, plus an unfulfilled promise
(SCAI/ITE-10) for the part we actually need.

## 6. What to take, precisely

- **Take:** the predicate/statement/envelope split as an *organizing
  principle* for our own baseline-attestation payload — one stable
  signed envelope, a `scruple-vendor-baseline/v1` predicate type we own
  and can version independently (P1–P8 as required fields), so adding a
  ninth property later doesn't touch how anything is signed.
- **Take:** the ITE numbering/status discipline (Accepted/Draft,
  Sponsor-owned, dated, one doc per proposal) as a lightweight model for
  amending our own P1–P8 doc's own change log, which already does
  something similar informally.
- **Take (with caution):** SCAI's pattern of "claim + pointer to
  external evidence, verification is the consumer's job" as the shape
  for how a vendor declares `attestation.provider` — but note precisely
  that in SCAI's own design this is a deliberately unclosed loop; ours
  cannot be. Scruple's witness server, not the vendor, must be the
  verifier of record for that evidence, or we inherit in-toto's own
  P1/P3 failure mode.
- **Do not take:** the layout/step/threshold/artifact-rule machinery as
  our compliance-checking mechanism. It is a well-built answer to "did
  the right people run the right commands on the right files," which is
  not our question. Our question is "was the environment built so that
  the answer to the first question can't be gamed by the party being
  measured" — in-toto assumes that away by design, and says so in its
  own code comments.
