# Canonicalization — what `workflow_hash` is a hash *of*

**Status:** Built. WO-21 of `WO-SERIES-2-PROVING-IT.md`, from a live bug WO-20
found.
**Binds:** `lib/leaf/registry.yaml` (`canonicalization_profiles`, and the
`workflow_hash` preimage), `MODEL_WRITE_HOOK.md` §6 and §8 items 3 and 4,
`H4-DUKPT-CAPTURE-COMPONENT.md` §10 C-1.
**Code:** `lib/leaf/canonicalJson.ts` (TypeScript),
`packages/scruple-api/scruple_api/canonical.py` (Python),
`test/vectors/canonicalization-vectors.json` (shared vectors),
`test/v2/canonicalization.test.ts`,
`packages/scruple-host-sdk/tests/test_canonicalization.py`.

---

## 0. The short version

`workflow_hash`'s preimage was `sha256(canonicalize(doc))`, and `canonicalize`
handed every scalar to the host language's JSON number formatter. `1e-5` is
`0.00001` under JavaScript and `1e-05` under Python. **Two conforming
implementations therefore computed different hashes for the same document, and
every leaf one wrote failed verification against the other — indistinguishable
from tampering.**

It is now **RFC 8785**, the JSON Canonicalization Scheme, in both languages,
held together by shared vectors whose inputs are raw document *text*.

Four things came out of it, in descending order of how much they matter:

1. **Four of the seven `workflow_hash` rows in `data/scruple.db` cannot be
   reproduced under the preimage this estate documents** — for an older reason,
   not this one. A 2026-07-13 commit made the formula canonical without a
   version marker, and those rows still carry the same `leaf_scheme` as the
   rows written after it. §5. **A data-integrity finding, not a code bug.**
2. **The divergence was live on the canvas path**, not only on training.
   A shipped ComfyUI graph in `docs/provenance-bundles/` carries `"cfg": 3.0`
   and hashed two ways. Verified, not assumed. §2.
3. **No leaf-scheme bump was required**, and the reason is specific rather than
   convenient: the shipped TypeScript was *already* RFC 8785 conformant for
   every document that is valid JSON. §4.
4. **Floats were not the only divergence.** Large integers, `-0`, astral-plane
   keys, non-ASCII strings, `NaN`, `undefined` and non-plain objects each
   diverge or silently corrupt, and three of them produced a hash of something
   that was not the document. §3.

---

## 1. Where the rule was missing

`lib/scruple/canonicalWorkflow.ts` said, in full:

> recursively sort object keys alphabetically; preserve array order; no
> whitespace.

That is a complete rule for **structure** and no rule at all for **scalars**.
Every leaf value went through `JSON.stringify(value)`, which is a delegation to
whatever the implementing language does — and the registry's prose said the
same thing, so a second implementor reading it would write `json.dumps` and
believe they had complied.

The estate had already learned this once and only in one place. §10 C-1 of the
H-4 spec defines the ratchet MAC preimage and **refuses floats outright**,
saying so in the error text. WO-20 then hit the same wall from the other side
and worked around it locally: `training_recipe()` commits every float as a
quoted decimal string. Both are correct inside this repo. Neither is checkable
against anything outside it — and the WO-20 workaround has a defect of its own
(§7.3).

The workflow preimage never had to care, because until a training recipe went
through it, no document it carried was mostly floats. That is a statement about
what had been *tried*, not about what was *safe*.

---

## 2. What actually diverges — measured

Every row below was produced by running both languages, not by reading a spec.
`node -e 'JSON.stringify(x)'` against `python3 -c 'json.dumps(x)'`.

### 2.1 Numbers

| JSON text | JavaScript | Python | |
|---|---|---|---|
| `1e-4` | `0.0001` | `0.0001` | agree |
| `1e-5` | `0.00001` | `1e-05` | **differ** — the fixed/exponential threshold is 1e-7 in JS and 1e-4 in Python |
| `5e-6` | `0.000005` | `5e-06` | **differ** |
| `1e-7` | `1e-7` | `1e-07` | **differ** — *both* chose exponential and still disagree: Python pads the exponent to two digits |
| `1.0` | `1` | `1.0` | **differ** — JavaScript has no integer type to lose |
| `1e16` | `10000000000000000` | `1e+16` | **differ** — the upper threshold is 1e21 in JS and 1e16 in Python |
| `-0.0` | `0` | `-0.0` | **differ** — and JavaScript loses the sign entirely |
| `3.5`, `0.1`, `1/3` | same | same | agree — which is why this survived so long |

**Two independent thresholds and an exponent-padding difference**, not one
bug. A fix that only handled `1e-5` would have left `1e-7` and `1e16` broken.

### 2.2 Integers past the double range

| JSON text | JavaScript | Python |
|---|---|---|
| `9007199254740993` | parses to `9007199254740992` | parses exactly |
| `123456789012345678901234567890` | `1.2345678901234568e+29` | exact |

This is a **parse** divergence, not a formatting one. By the time JavaScript's
canonicalizer runs, the two languages are no longer holding the same document
and JavaScript cannot tell. §7.2.

### 2.3 Keys and strings

| | JavaScript | Python |
|---|---|---|
| key sort with an astral key | `["😀","","�"]` — UTF-16 code unit | `["","�","😀"]` — code point |
| non-ASCII value | literal UTF-8 | `\u`-escaped unless `ensure_ascii=False` |
| U+007F (DEL) | literal | escaped unless `ensure_ascii=False` |

The astral key case is **exactly the trap §10 C-1 closed for the ratchet**,
arriving in a second preimage that had never heard of it.

### 2.4 Values that are not JSON, where the old code answered anyway

| value | old `canonicalize()` output | what that means |
|---|---|---|
| `NaN` / `Infinity` | `{"lr":null}` | a NaN hyperparameter committed as *no value* — a false record |
| `undefined` | `{"a":undefined,"b":1}` | **not parseable JSON.** No verifier in any language could reproduce this hash |
| sparse array | `[1,,2]` | same |
| `new Date()` | `{}` | the hash committed to nothing at all |

Python's side of the same list: `json.dumps(float('nan'))` emits the bare token
`NaN`, which is also not JSON, and does it *loudly* rather than silently.

### 2.5 The canvas file that settles the scope question

WO-20 flagged this as a live cross-path issue rather than a training curiosity,
and said to verify it rather than take it on trust. Verified:

```
docs/provenance-bundles/bundle-29e9a40e1d43/iterations/video-1/workflow_api.json
  "cfg": 3.0,  "base_shift": 0.95,  "max_shift": 2.05,  "strength": 0.85

  JavaScript  d39a015eb81b7af7a29f9e266dcbcbd4604df1cb6baab79e3e0ed756e72c0ee3
  Python      40fbeb048cac…
```

One file on disk, two hashes, six ComfyUI graphs checked and one of them
affected. **`3.0` is the divergent value; `0.95` and `2.05` are not.** That is
the whole hazard in one line: the property that breaks a graph is not "has
floats", it is "has a float that happens to sit on one side of a threshold" —
which is invisible to inspection and stable until it isn't.

---

## 3. The number rule, and why RFC 8785

Three options were real:

1. **Refuse floats, as `canonical_preimage` does.** Consistent with C-1 and
   wrong here: a ComfyUI graph legitimately carries `cfg`, `denoise`,
   `guidance`. Refusing them refuses the canvas path.
2. **Commit floats as round-trip decimal strings**, WO-20's `encode_number`.
   Works, and see §7.3 for the defect it carries.
3. **Adopt RFC 8785.**

**RFC 8785 was taken.** Inventing a number canonicalization is a well-known way
to be subtly wrong for years, and this estate had already started two private
rules. The decisive property is not that the RFC is published — it is *what it
mandates*:

> §3.2.2.3 — numbers MUST be serialized per ECMA-262 §7.1.12.1 (ECMAScript's
> own `Number::toString`), including the Note 2 enhancement. NaN and Infinity
> MUST cause a compliant implementation to terminate with an error.
>
> §3.2.3 — property names are sorted as arrays of **UTF-16 code units**.
>
> §3.2.2.2 — the five named escapes, lowercase `\u00hh` below U+0020,
> everything else literal.

`JSON.stringify` of a finite number **is** `Number::toString`. `Array#sort` on
strings **is** a UTF-16 code-unit comparison. `JSON.stringify` of a string
**is** §3.2.2.2. So the shipped TypeScript was already conformant, and the cost
of the RFC lands entirely on the Python side.

### What JCS costs

- **Python has to implement ECMAScript number formatting.**
  `scruple_api.canonical.es_number_to_string` is ECMA-262 §6.1.6.1.20 by hand:
  `repr(float)` supplies the shortest round-tripping digits (the hard half,
  and a property CPython has had since 3.1), and the rest is layout — the two
  fixed/exponential thresholds and the unpadded exponent. Checked against
  JavaScript over **22,639 doubles** (random bit patterns, every power of ten
  in range, and structured sweeps): **zero mismatches**, plus a
  `float(format(x)) == x` round-trip assertion in the suite itself.
- **JCS's key sort disagrees with the ratchet's.** §6 below.
- **`1` and `1.0` become the same document.** JCS defines every JSON number as
  an IEEE-754 double, so Python must deliberately collapse the distinction it
  can see. A Python implementation that preserved it would be self-consistent
  and unable to verify a single leaf.
- **No dependency was available.** `scruple-api` declares
  `dependencies = []` because it is vendored into embedded interpreters where
  pip cannot be assumed, so a PyPI JCS package was not an option.

`decimal` and `math` from the standard library; nothing else.

---

## 4. Why this was not a leaf-scheme bump

The WO's instruction was to treat this as a scheme bump unless the alternative
could be argued explicitly. Here is the argument.

`registry.yaml`'s `leaf_schemes` govern **which fields enter a preimage and in
what order**. They say nothing about how a field's own document becomes bytes,
which is precisely the omission that produced this bug. Those are two
orthogonal axes and a leaf's replay needs both, so the registry now carries
`canonicalization_profiles` beside `leaf_schemes`.

**`jcs-1` and `legacy-1` are byte-identical over every document that is valid
JSON.** Not approximately — identically, for the reason in §3: the RFC mandates
the two behaviours the shipped implementation already had. Nothing that
`legacy-1` hashed to a meaningful value hashes to a different one now.

What changed is **refusal**. The four classes in §2.4 previously produced a
hash of something other than the document; they now raise. That is a behaviour
change only for leaves whose hash was already meaningless, and
`canonicalizeLegacy()` is retained so such a leaf can still be replayed and
read rather than declared unhashable.

**The claim is pinned, not asserted.** `legacy_leaves` in the vector file
carries hashes captured from the pre-WO-21 implementation
(`git show 257b942:lib/scruple/canonicalWorkflow.ts`) for twelve real
documents: **eight** carry the compatibility claim for `jcs-1` — two witnessed
rows out of `data/scruple.db` and six shipped provenance-bundle graphs — and
the remaining four are the `insertion-order-1` rows of §5, which are asserted
NOT to reproduce. Both suites check them, the *generator itself*
refuses to write a vector file if any of them moved, and the Python suite makes
the stronger statement: not "the fix changed nothing" but **"the fix made a
second language able to reproduce what already shipped."**

---

## 5. The finding: four leaves that nothing can reproduce

WO-21 went looking for leaves this bug had already damaged. It found a
different, older break.

`data/scruple.db` holds **seven** rows with a non-null `workflow_hash`. Under
the preimage `lib/leaf/registry.yaml` documents, in either language:

| rows | written | reproduces under the documented preimage |
|---|---|---|
| 165, 171, 172 | 2026-07-05 / 07-13 | **yes** |
| 166, 167, 168, 169 | 2026-07-05 | **no** |

**Four of seven.** And the graphs are not corrupt: each of those rows'
`input_hash` reproduces *exactly* from the same stored `generationSpec`, which
proves the document is intact and the **formula** is what changed.

It changed at **`ec188d6`, 2026-07-13, "WO-A2 canonical workflow_hash — sorted
keys, whitespace-free"**. Before it, `workflow_hash` was plain `JSON.stringify`
in the object's own key order. That commit is the right change, and it shipped
**with no version marker**: rows 166–169 carry `leaf_scheme: 'v2.2'`, exactly
like the rows written after it. Nothing in the record tells an auditor which
rule to replay, and replaying them under the documented preimage produces a
mismatch that reads as tampering.

**This is the same failure WO-21 exists to prevent, having already happened
once.** It is the reason `canonicalization_profiles` is a first-class registry
section rather than a sentence in a comment: the estate has demonstrated it
will change a preimage rule again.

### What was done about it

- The profile is named `insertion-order-1`, declared in the registry with the
  affected row ids and the commit.
- All four graphs and their hashes are fixtures in
  `test/vectors/canonicalization-vectors.json`, and both suites assert **both
  halves** — that the old rule reproduces them, and that the current rule does
  not silently agree.
- `canonicalizeInsertionOrder()` exists for replay in both suites. Nothing
  writes through it.

### What was *not* done, and needs a decision

- **No column records which profile a row was written under.** The fixtures
  make the four rows replayable *because WO-21 identified them by hand*. A
  `canonicalization_profile` column, defaulting to `insertion-order-1` for rows
  before 2026-07-13 and `jcs-1` after, is the durable fix. It is a migration,
  and `lib/db/migrations/**` was out of this WO's scope.
- **Both languages happen to reproduce all four**, because these graphs are
  keyed `"3"`, `"4"`, `"5"`… and numeric-like keys order the same way under
  V8's own object ordering and Python's insertion order. **That is a
  coincidence of this corpus, not a property of the profile.** A pre-2026-07-13
  graph with non-numeric top-level keys is reproducible only in the serializer
  that wrote it. There are none in `data/scruple.db`; there is no guarantee
  about a customer's.

---

## 6. Two key-sort rules in one estate, deliberately

| preimage | sort | authority |
|---|---|---|
| ratchet MAC (`canonical_preimage`) | Unicode **code point** | H-4 §10 C-1 |
| `workflow_hash` (`jcs-1`) | UTF-16 **code unit** | RFC 8785 §3.2.3 |

They disagree for any key above the BMP. Both are correct for their own
preimage and neither should be changed to match the other:

- The ratchet's field set is a **closed list of ASCII identifiers** —
  `component_id`, `counter`, `content_hash` and twenty siblings. The two rules
  coincide over it, exactly, forever. Changing C-1 to match JCS would
  invalidate every component in the field for a difference that cannot be
  observed.
- `workflow_hash`'s document is **arbitrary customer JSON** where an astral key
  is entirely possible, and its rule is the one an outside verifier can look up
  in an RFC.

Recorded here and in both module headers because "these two sort differently"
is exactly the kind of thing that gets "fixed" by someone tidying, and the fix
would be a field incident.

---

## 7. Limits, stated so nobody looks for them

### 7.1 The other two preimages are untouched

`input_hash` and `model_fingerprints_hash` are still the host language's own
serializer. `lib/leaf/hashes.ts`'s header records why they must not be edited,
and that reasoning still holds — with one thing now added to it:

- **`input_hash`** is safe *today* because every value in its field set is a
  string. That is a property of the current field set, not of the formula.
- **`model_fingerprints_hash`** carries a **float `mtime` per file**. An
  integral mtime would diverge exactly the way a learning rate did. Every
  fingerprint manifest in the current corpus reproduces in both languages
  (checked); the exposure is real and unrealised.

Fixing either **is** a scheme bump, because unlike `workflow_hash` their
shipped preimage is not canonical JSON under any spec, so a corrected version
is a different hash for every leaf that exists. Both entries in the registry
now say so.

### 7.1b The new refusals throw, and no call site catches them

`hashWorkflow` now raises where it used to answer, and all three call sites —
`lib/iterations/ingest.ts`, `app/api/v2/witness/route.ts` and
`services/scruple-capture/src/leaf.ts` — call it unguarded. That was checked
before the refusals were added rather than after:

**Every one of the three receives `JSON.parse` output.** The route's graph
comes through a Zod `z.record(z.unknown())` over a parsed body, ingest's comes
from a parsed provider response, and the sidecar's from a parsed WS frame.
`JSON.parse` cannot produce `NaN`, `Infinity`, `undefined`, a sparse array or a
`Date`, so five of the six refusals are **unreachable from any shipped path** —
which is precisely why they were safe to add without a scheme bump or a
catch.

The sixth is reachable. A JSON document may contain `"\ud800"`, and
`JSON.parse` will hand back a string with a lone surrogate. Such a graph now
throws where it previously hashed. The trade is deliberate: that string cannot
be encoded as UTF-8, so the "hash" it previously produced was of bytes Python
could not represent at all, and the event is better refused at the gate than
recorded with a hash no second party can reproduce. It is named here so that if
it is ever seen in the field it reads as a known refusal rather than a crash.

### 7.2 An integer past the double range cannot be reconciled

Python parses `9007199254740993` exactly and **refuses**, because it can see
that JavaScript is not holding the same document. JavaScript's parser rounded
it to `…992` before the canonicalizer was called and **cannot detect the
loss**. There is no check that would work on that side, so none was written and
the asymmetry is a pinned property of the vectors (`python_refuses`) rather
than an undiscovered surprise.

The bound is **exactness, not `Number.isSafeInteger`**. `2**53` is one past the
safe range and is nonetheless represented exactly; refusing it would refuse a
document JavaScript handles perfectly, which is a cross-language failure
introduced by the fix rather than removed by it.

### 7.3 WO-20's `encode_number` moved the problem rather than removing it

`training_recipe()` commits a float as `repr(x)` — a **string**, which
canonicalizes identically everywhere. True, and it hides that the string is
Python-specific: a JavaScript component encoding the same double writes
`"0.00001"` where Python writes `"1e-05"`, so two components now disagree about
the recipe *document* and the hash faithfully reports the disagreement. Pinned
by `test_wo20s_string_encoding_would_itself_have_diverged`.

With `jcs-1` the workaround is unnecessary: the float can be committed as a
number, and the receipt reads `1e-05` rather than `"1e-05"`. **Changing
`model_write.py` was outside this WO's scope** and is the natural next edit —
it is a change to what the recipe document *is*, so it needs the
`workflow_hash` comparison in §8 landed first or two components will disagree
during the transition with nothing to catch it.

---

## 8. The `workflow_hash` comparison (WO-20 §6.1)

The finding: a component computes the recipe hash into `capture.workflow_hash`,
which **is** inside the ratchet MAC; the route independently recomputes it from
`body.training` via `hashGraphOrTraining`; **nothing compares them.** The route
already refuses when `model_fingerprints` and `model_fingerprints_hash`
disagree, with the right reason attached.

**Decision: the comparison must exist, and it must refuse rather than pick a
side.** The argument is the fingerprints argument with more force — a silent
mismatch means the MAC authenticates a hash the leaf does not carry, and the
leaf carries a hash nothing authenticated. That is worse than either value
being wrong, because both look signed.

`app/api/v2/witness/route.ts` was **outside this WO's scope** (three agents are
working concurrently and `app/**` is another's). So the predicate was written
where it belongs instead of the check being skipped or duplicated:

```ts
// lib/leaf/hashes.ts
export function hashDisagreement(computed, supplied):
  { computed: string; supplied: string } | null
```

Absence is not disagreement — a `/v2` submission is zero-content and may carry
the hash alone, the document alone, or neither; only when **both** are present
is agreement being asserted. Tested in
`test/v2/canonicalization.test.ts`, including the case it exists for: the same
recipe under two canonicalizations.

**What remains for the route owner** is one call beside the existing
fingerprints check:

```ts
const wfDisagree = hashDisagreement(workflowHash, body.component?.capture?.workflow_hash);
if (wfDisagree) {
  return v2Error(
    'invalid_body',
    'capture.workflow_hash and the recomputed workflow hash disagree. ' +
      'One of the two describes a different document.',
    wfDisagree,
  );
}
```

---

## 9. Open, and where each one goes

| # | Item | Where it lands |
|---|---|---|
| 1 | No column records which canonicalization profile a row was written under; the four pre-`ec188d6` rows are replayable only because WO-21 identified them by hand | `lib/db/migrations/**` + `lib/leaf/registry.yaml`. §5. |
| 2 | `capture.workflow_hash` and the server's recomputation are still not compared | `app/api/v2/witness/route.ts`, one call. The predicate and its tests exist. §8. |
| 3 | `input_hash` and `model_fingerprints_hash` are still host-formatter-dependent; the latter carries a float per file | A leaf-scheme bump, not an edit. Registry entries now say so. §7.1. |
| 4 | `model_write.encode_number` can be retired now that floats canonicalize portably | `packages/scruple-api/scruple_api/model_write.py`, **after** §8 lands. §7.3. |
| 5 | Three copies of a `canonicalize`-shaped function remain in TypeScript — `lib/canvas/manifest.ts` and `lib/baseline/ingest_check.ts` each have their own | Both should import `lib/leaf/canonicalJson`. Neither was in scope; `lib/scruple/canonicalWorkflow.ts` was reduced to a re-export as the precedent. |
| 6 | No probe run behind any of this | DEFECT-2 stands, as in WO-20. This WO produced a rule, two implementations and a measurement — not a conformance result. |
