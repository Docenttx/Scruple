# WO-S1 — the two things the Blender client could not reach

_2026-09-07. Scope: `/data/scruple-web` only. Both gaps were verified by hand
against the scratch app before the WO was written; this closes them._

Sandbox throughout: app `:3902`, witness `:5899` (kms-http against the
surrogate), CVM surrogate `:8799`. **Production `:5799` and `:3001` were never
contacted.** Every leaf below is surrogate-signed and therefore
**software-backed**; nothing here is hardware-backed and nothing records it as
such.

---

## S1-a — `/api/v2/receipt` discloses nothing a verifier needs

### What was actually wrong, which was one level worse than the WO stated

The WO said the receipt returns none of the four H-1 fields. It does not —
**and neither does anything else, because the application tier never stored
them.** Both write doors read `res.signature` into `iterations.witness_signature`
and dropped `leaf_signature` / `leaf_signer_key_id` / `leaf_signature_alg` /
`signer_surrogate` on the floor:

- `app/api/v2/witness/route.ts` — `witnessSig = String(res.signature ?? '')`
- `lib/iterations/ingest.ts` — `witnessResult?.signature ?? null`

`res.signature` **is the HMAC**. `services/witness-server/leaf_signer.js`'s own
header says so: H-1 "demoted [it] to what it always was — a transport seal
between the application tier and this service (H-2)". And
`app/api/v2/verify/[content_hash]/route.ts` computed

```ts
// An ECDSA leaf signature is stored in witness_signature.  ← it is not
const independentlyVerifiable = Boolean(row.witness_signature);
```

So the route that exists to answer "can a third party check this?" replaced one
constant with another: `false` for every leaf became **`true` for every
witnessed leaf**. The field never meant anything.

### What was done

| | |
|---|---|
| `lib/db/migrations/052_leaf_signature_disclosure.sql` | five columns on `iterations`: the four H-1 fields plus `leaf_signature_state` |
| `lib/leaf/signatureDisclosure.ts` | **one** function that renders the disclosure; receipt, verify and the witness response all call it |
| `app/api/v2/witness/route.ts` | persists the four fields; returns the disclosure and `canonicalization_profile` on the 201 |
| `lib/iterations/ingest.ts` | same, on the canvas/ingest door |
| `app/api/v2/receipt/[leaf_id]/route.ts` | **additive**: `signature`, `independently_verifiable`, `canonicalization_profile`, `component` |
| `app/api/v2/verify/[content_hash]/route.ts` | **additive** `signature` block; `independently_verifiable` now reads the ECDSA column, not the HMAC |
| `lib/canvas/baseline.ts` | tamper surface re-recorded — `ingest.ts` is a tracked file (see below) |

**Three states, never two.** `leaf_signature_state` exists because a null
signature has three different causes and collapsing them is the same defect
this estate refuses in migrations 046 and 050:

- `signed` — the witness answered with an ECDSA signature; it is on the row.
- `unsigned` — the witness answered and had none (signing disabled, or the KMS
  unreachable for that leaf). A fact about the leaf.
- `unknown` (NULL) — nobody asked or nobody answered: every row written before
  052, every leaf recorded while the witness was down, every §9.6 continuity
  record. **Not** a statement that the leaf is unsigned.

**No backfill, deliberately.** Every pre-existing row keeps NULL. The witness DB
holds signatures for many of them, but this tier never observed those, and
writing a plausible value would be the application tier asserting something it
never saw. Recovering them is a reconciliation against the witness DB, with its
own evidence. See *Left open* below.

**`key_protection: 'undeclared'`, not `'hardware'`.** A non-surrogate key id
means only that the leaf was not signed by `services/cvm-surrogate`. The witness
does not transmit the key's protection mode, so the disclosure makes no
hardware claim either way — and a test asserts the word never appears.

### Gate — proved by side effect on the live sandbox

Leaf 27, `/api/v2/witness` on `:3902`, artifact bytes on disk at
`/mnt/corpus/scruple-blender-l2/s1/s1-artifact.bin`:

```
GET /api/v2/receipt/27
  signature.state             signed
  signature.leaf_signature    MEUCIQC+jRo3llFXlO/XeteJqKhBQGPJVWe6fFYfQUbAjRgqKgIg…
  signature.leaf_signer_key_id  ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEY…
  signature.leaf_signature_alg  ECDSA_SHA_256
  signature.leaf_signer_surrogate  true
  signature.key_protection    software
  independently_verifiable    true
  canonicalization_profile    jcs-2
```

Checked against `GET $SCRUPLE_CVM_SURROGATE/testnet/pubkey.pem`:

```
MUST FIRE  · signature over the 32 raw bytes of leaf_hash : True
CONTROL    · same signature over the ASCII hex spelling   : False
CONTROL    · one bit flipped in leaf_hash                 : False
CONTROL    · one bit flipped in the signature             : False
MUST FIRE  · artifact on disk re-hashes to content_hash   : True
```

The ASCII control is why the receipt spells out *which bytes* were signed: the
KMS signs the 32 **raw** bytes, and a verifier that hashes the hex spelling
gets a clean failure that reads exactly like tampering.

**Controls — a leaf with no signature, reported honestly and NOT as verifiable:**

```
receipt 28  (§9.6 continuity — deliberately never witnessed)
  witnessed false · state unknown · independently_verifiable false
  verification null · key_protection unknown

receipt 20  (a WO-B3 leaf, written BEFORE migration 052)
  witnessed true  · state unknown · independently_verifiable false
  …and the witness DB DOES hold a signature for that leaf: MEUCIHVXOUzWQIl/HJ5+7Ebc… (surrogate=1)
```

Leaf 20 is the case the three-state design exists for: the leaf is signed, this
tier cannot show it, and the receipt says *we do not know* rather than *it is
unsigned*.

`/api/v2/verify`, same run:

```
MUST FIRE  signed leaf     found true  verifiable true   basis asymmetric_leaf_signature  surrogate true  software
CONTROL    unrecorded leaf found true  verifiable false  basis scruple_record  state unknown
CONTROL    ffff…ff         found false witnessed false
```

### Gate — in the suite

`test/v2/receipt-signature-disclosure.test.ts`, 19 tests. The signing stub is a
real P-256 key generated per run signing exactly what the surrogate signs for
`messageType: RAW` — a stub returning a fixed string would let a receipt
"disclose" something no verifier could ever check.

Mutation-tested (each mutation applied, suite run, mutation reverted):

| mutation | result |
|---|---|
| `verify` reads `Boolean(row.witness_signature)` again — the original defect | **1 failed** |
| `unknown` collapsed into `unsigned` | **5 failed** |
| the witness route drops the H-1 fields again | **9 failed** |
| _(none — restored)_ | 19 passed |

---

## S1-b — `witness_flow.witness()` cannot carry a component envelope

### What was done

`packages/scruple-host-sdk/scruple_host_sdk/witness_flow.py` gains six optional
parameters. **A caller that passes none of them sends byte-identical requests to
before** — asserted by a control test.

```
component=   the H-4 §4.3 envelope
capture=     what the component saw
mac=         the caller MACed it already
ratchet=     THIS FUNCTION MACs it, over the exact body it is about to send
input_hash=            } both are component_preimage fields; a component that
model_fingerprints_hash=} computed either could not MAC honestly without them
```

**`ratchet=` is the one to use, and it is why this had to be in the SDK.**
CANON_SKELETON §5 forbids an adapter assembling its own envelope, and the reason
is concrete: a MAC only means anything if it covers the field set the server
reconstructs from the submission. Passing the ratchet lets `witness()` call the
shared `component_preimage()` over the **finished body**, so there is no second
field list to drift. The ratchet also owns the counter — a caller's `counter` is
overwritten before the preimage is built, because MACing one counter and
shipping another authenticates nothing.

Refused **client-side, with no network call** (same posture as `NoBaselineError`):
envelope with no MAC, MAC with no envelope, both `mac` and `ratchet`, `capture`
with no component, pre-MACed envelope with no counter.

Also added, so the quoted sequence is entirely SDK-driven:

- `scruple_api.outcomes.ComponentOutcome` and `WitnessOutcome.component` /
  `.deduplicated` — appended with defaults, so every existing construction
  (including the no-op provider) is unchanged.
- `server_library.component_status()` — the reconciliation read. Both halves
  existed server-side; a vendor could produce the evidence and not read it back.
  It goes through `_http.submit(query=…)` rather than importing `urllib.parse`,
  because `test_queue_construction.py` pins the socket-capable module set at
  exactly two and that guard is right.

### Gate — the WO's sequence, through the SDK, against the live app

`/mnt/corpus/scruple-blender-l2/s1/s1b-live.py`. Provisioning, ratchet, MAC and
envelope are all `scruple_host_sdk`; nothing is assembled by hand.

```
provision      component_id=cab22e32-adec-49f4-84ae-d809df1b3a5d  counter=0

MUST FIRE  counter 0 delivered
  witness n0   leaf_id=38  witnessed=True  component={counter:0, verified:True, gap:0}

CONTROL    an UNSKIPPED sequence must report gap 0
  witness n1   leaf_id=39  witnessed=True  component={counter:1, verified:True, gap:0}
  witness n2   leaf_id=40  witnessed=True  component={counter:2, verified:True, gap:0}
  gaps: [0, 0, 0] — the detector is not simply always saying yes

MUST FIRE  skip counter 3, deliver counter 4 → gap 1
  counter 3 spent on a MAC that is never sent; ratchet now at 4
  witness n4   leaf_id=41  witnessed=True  component={counter:4, verified:True, gap:1}

GET /api/v2/components/status (via the SDK)
  counters: {last_verified: 4, delivered: 4, backfilled: 0}
  gaps: {open: 1, missing: 1, resolved: 0,
         list: [{from_counter: 3, to_counter: 3, missing_count: 1}]}

CONTROL    an envelope with no MAC never reaches the wire
  refused client-side; no counter spent
CONTROL    a caller that sends NO envelope is unchanged
  leaf_id=42  witnessed=True  component=None; still no counter spent
```

The gap leaf's receipt carries both halves of this WO at once:

```
GET /api/v2/receipt/41
  component  {component_id: cab22e32…, counter: 4, verified: true}
  signature  state signed · key_protection software · leaf_signer_surrogate true
  independently_verifiable true
```

### Gate — in the suite

`packages/scruple-host-sdk/tests/test_component_envelope.py`, 17 tests, against
an in-process server that **actually verifies the MAC** by deriving the same IK,
ratchetting in lockstep and recomputing over `component_preimage(body)`. That is
two Python callers agreeing; what makes it evidence rather than circularity is
that both halves are pinned across languages by fixtures this suite already
runs — `ratchet-vectors.json` for the key schedule and
`component-preimage-vectors.json` for the field set — and that the live run
above is the cross-language proof against the real TypeScript route.

Mutation-tested:

| mutation | result |
|---|---|
| envelope built but never attached to the body | **9 failed** |
| the ratchet's counter is not stamped (caller's wins) | **1 failed** |
| `gap` defaulted from `verified` | **2 failed** |
| _(none — restored)_ | 17 passed |

---

## Suites

| suite | before WO-S1 | after |
|---|---|---|
| `npm run test:v2` | 637 pass / 0 fail | **656 pass / 0 fail** |
| `npm run test:conformance` | — | 47 pass / 0 fail |
| `npm run test:integration` | — | 19 pass / 0 fail |
| `npm run test:sdk` | 175 pass / **2 fail** | **192 pass / 2 fail** |

### The two SDK failures are pre-existing and are NOT from this WO

Both are in `tests/test_model_write.py` and both fail at `HEAD` (`79f5507`),
before any change here. Diagnosed but deliberately **not fixed** — they belong
to the `model_write` path, not to WO-S1, and one of them may be a real defect
that a wrong fix would bury:

1. `test_the_dataset_lands_on_input_hash_with_the_shipped_formula` — a **stale
   pin**. The test hardcodes `01b1a7a6…`, the jcs-1 value from a plain
   `JSON.stringify`. Under jcs-2 (2026-09-03) `hashRunInputs` canonicalizes, and
   **the Python SDK and the TypeScript now agree on `9cac7c39…`** — measured
   both sides. The two implementations are consistent; the vector was not
   updated with the profile.
2. `test_a_float_cannot_sneak_into_a_fixed_order_preimage` —
   `hash_model_fingerprints({"a": {"bytes": 1.5}})` no longer raises
   `TrainingRecipeError`. **This one may be real**: a float in a fixed-order
   preimage is the exact cross-language divergence the sibling test documents
   (`1e-05` in Python, `0.00001` in JS). It needs its own look, not a passing
   assertion.

### One deliberate re-record: `lib/canvas/baseline.ts`

`lib/iterations/ingest.ts` is on the canvas tamper surface, so persisting the
signature fields moved the recorded hash. Re-recorded, with the reason on the
constant, as the failing test instructs:

```
8daff6dacc99c8c3d699c5527b9316c470f4492c811b76e416cdfefbf10f6e3a  (WO-25)
42ba03bd82647ffafc8c1adedfacd0ab7ff47d91a541a48d45955de418e6d7c6  (WO-S1a)
```

Nothing about what canvas *captures* changed; what a canvas leaf can be
*checked against* did, which is squarely what that surface covers.

---

## Left open — named, not silently absent

1. **No backfill of pre-052 rows.** Every existing leaf reports
   `state: "unknown"` and `independently_verifiable: false`, including leaves
   the witness holds real signatures for (demonstrated on leaf 20). This is the
   honest answer from this tier, not the best available one. Recovering them
   means reconciling `iterations.witness_id` / `leaf_hash` against the witness
   DB — a separate job with its own evidence, and it needs a decision about what
   a recovered-not-observed signature is worth.
2. **The app does not serve the verifying key.** A client that can only reach
   the app still cannot fetch the public key: there is no proxy for the
   witness's `/api/signer/pubkey`, and the receipt therefore names the path but
   reports `public_key_url: null` unless `SCRUPLE_WITNESS_PUBLIC_URL` is set. A
   new unauthenticated route on a tree that also serves production was outside
   what this WO authorised. **Founder decision:** publish the witness address,
   or add the proxy.
3. **The witness's own read surface still hides the signature.**
   `GET /api/witness/{projectId}` (`server.js:870`) selects the leaf preimage
   fields and not `leaf_signature`, so the witness cannot be asked for a
   signature it holds. Untouched: the deployed witness is `/opt/scruple-witness`
   and out of this WO's scope.
4. **A scratch API key was minted** in the sandbox DB: `k_s1b` for tenant
   `u_b3live`, carrying `component:provision` (the existing `k_b3live` does
   not). Sandbox only; `/mnt/corpus/scruple-blender-l2/s1/s1b-api-key.txt`.
