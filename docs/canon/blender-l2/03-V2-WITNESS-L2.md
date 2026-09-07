# WO-B3 — The v2 witness path, at L2

_2026-09-07. Follows `01-GAP.md` (the inventory) and `02-SDK-ADOPTION.md`
(the SDK). Machine-readable twin: `03-l2-evidence.json`, produced by
`tests/live/witness_l2_in_blender.py` inside real Blender against the
scratch stack. Control transcripts: `03-controls.log`._

---

## The headline: no leaf this addon produced could ever have landed

WO-B2 left the addon on the v2 routes and 176 tests green. It could not
witness anything.

`kind` is a **closed enum** on `/api/v2/witness` — `z.enum(['document_save',
'artifact', 'graph_execute', 'model_write'])`, `route.ts:110`. The addon
sent Blender's own words. `gap.json` flagged it (endpoints row 4: "the
addon's trigger labels are not members of it") and B2 did not close it,
because every test ran against a mock that accepted any string.

Measured against the scratch app, not read off the source:

```
$ for K in render save export document_save artifact; do ... POST /api/v2/witness ... done
kind=render         -> invalid_body
kind=save           -> invalid_body
kind=export         -> invalid_body
kind=document_save  -> OK leaf_id=4
kind=artifact       -> OK leaf_id=5
```

A 400 is **not queued**: `http.submit()` spools transport failures and
5xx only (`vendor/scruple_host_sdk/http.py:162`). So the capture was not
delayed, it was gone, and the addon reported it as an error string on a
panel nobody was watching.

`adapter/flow.py` now maps Blender's three captures onto the enum
(`render`→`artifact`, `save`→`document_save`, `export`→`artifact`) and
refuses an unmapped one **client-side**, before any request. Blender's own
word is not lost: it stays in the graph as `kind: blender_render` and
`trigger`, both of which enter `workflow_hash`.

**The live control.** With the mapping reverted to `render`, the same
harness against the same stack:

```
state: rejected | leaf_id: None | error: HTTP 400
queued? False -> a 400 is NOT retried; the capture is gone
FAILED CHECKS: baseline_is_the_measured_surface, original_verifies_found,
               every_leaf_witnessed
```

---

## The gate

> A leaf produced from a **real headless Blender render** appears in the
> scratch witness; its `content_hash` re-hashes from the PNG on disk and
> matches; `/api/v2/verify` reports it independently verifiable.
> Control: a leaf whose bytes are altered by one pixel must FAIL
> verification — show both.

Four leaves, three distinct Cycles renders and one `.blend`, all produced
by `blender --background --factory-startup` on this box. Baseline
`a3a49346…`, established over the **installed zip's** own bytes before
anything was witnessed.

| leaf | kind | artifact | bytes | `content_hash` | re-hashes? | in witness DB? | tier |
|---:|---|---|---:|---|---|---|---|
| 15 | artifact | `torus.png` | 10 496 | `c35c3ce62141…` | ✅ | ✅ signed | undisclosed |
| 16 | artifact | `monkey.png` | 15 851 | `5cda2503d58a…` | ✅ | ✅ signed | undisclosed |
| 17 | artifact | `cone.png` | 9 067 | `8f387a997e31…` | ✅ | ✅ signed | undisclosed |
| 18 | document_save | `l2-scene.blend` | 425 964 | `531a6f17c0b4…` | ✅ | ✅ signed | undisclosed |

Checked from the shell, independently of the addon that produced them:

```
$ for f in b3/torus.png b3/monkey.png b3/cone.png b3/l2-scene.blend; do sha256sum $f; done
c35c3ce621419ec6512d928640ee7a06a438d36a084b92c6b74e92098cdc9c99  b3/torus.png
5cda2503d58ada8af65ebc9ae275ef619adecf5fe189e4d0644a94bfa5ecf440  b3/monkey.png
8f387a997e31b4d612d4718d5c93b9f94e9048952df4b0757b6f98f302092096  b3/cone.png
531a6f17c0b46114b9b67f4ffe5b9b2d4ca43b0aaabaf82cb3409a627c5a1a92  b3/l2-scene.blend

$ sqlite3 scruple-scratch.db "select id, substr(output_hash,1,16), output_content_type,
                                     canonicalization_profile, mime_declared, seal_state
                                FROM iterations WHERE id BETWEEN 15 AND 18;"
15|c35c3ce621419ec6|image/png             |jcs-2|1|undeclared
16|5cda2503d58ada8a|image/png             |jcs-2|1|undeclared
17|8f387a997e31b4d6|image/png             |jcs-2|1|undeclared
18|531a6f17c0b46114|application/x-blender |jcs-2|1|undeclared
```

Four `sha256sum` lines and four `output_hash` values, computed by two
programs that share no code.

**The control.** One pixel of `torus.png` inverted with Blender's own
image API and saved as a real PNG — same 160×120 dimensions, valid file,
10 488 bytes against 10 496:

```
original  c35c3ce62141…  ->  /api/v2/verify  found: true
altered   23774427bbd1…  ->  /api/v2/verify  found: false
   "This content hash is not on Scruple's record. That means Scruple did
    not witness it; it says nothing about the file itself."
```

**Sixteen checks, all green**, in `03-l2-evidence.json` under `checks`.
Three of them are honesty gates that assert what the addon must *not*
claim: `no_leaf_claims_verified_assurance`,
`no_leaf_claims_a_checked_verification`,
`signature_absence_recorded_as_not_disclosed`.

---

## "`/api/v2/verify` reports it independently verifiable" — it does, and it is wrong

This is the part of the gate that passes and should not be trusted, and
it is the most important thing in this report.

`/api/v2/verify` answered `independently_verifiable: true` with
`verification_basis.kind: "asymmetric_leaf_signature"` and
`algorithm: "ECDSA_SHA_256"` for every one of the four leaves. It answers
that for **any** witnessed leaf, because it derives the flag from
`iterations.witness_signature` (`verify/[content_hash]/route.ts:64`) —
and that column holds the witness server's **HMAC**, not an ECDSA
signature. H-2 demoted the HMAC to a transport seal precisely because
Scruple can forge it and nobody else can check it.

**Demonstrated, not inferred.** Stop the CVM surrogate so the witness
server's leaf signer cannot sign, then witness a leaf:

```
$ kill <surrogate>;  POST /api/v2/witness  ->  witnessed=True leaf_id=3
$ sqlite3 witness-scratch.db "select leaf_signature from witnesses ..."
leaf_signature = NULL                    ← nothing signed it

$ curl /api/v2/verify/<that hash>
independently_verifiable = True
basis kind = asymmetric_leaf_signature | alg = ECDSA_SHA_256
```

That is `docs/canon/studio-l2/04-PLAN.md:231`'s "sharp variant" gate, and
it fails. **This addon therefore records `independently_verifiable` as a
claim and never as a check** — `LeafAssurance` carries
`independently_verifiable_claimed` and
`independently_verifiable_checked` as two fields, and the second is
`False` on every leaf, including when a signature *is* disclosed. The
operator's wording is *"scruple.ai says independently verifiable: yes …
This addon has not checked it and holds no key with which to."*

### Where the signature actually goes

The evidence exists. The app tier discards it.

| tier | has the H-1 triple? |
|---|---|
| witness server (`witnesses` table) | **yes** — `leaf_signature`, `leaf_signer_key_id`, `leaf_signature_alg`, `leaf_signer_surrogate=1` on all four leaves |
| app (`iterations` table) | **no column exists** — `PRAGMA table_info(iterations)` returns 0 matches for `leaf_signature` |
| `POST /api/v2/witness` response | no |
| `GET /api/v2/receipt/{leaf_id}` | no |

The route reads `res.signature` (the HMAC) into `witnessSig` at
`app/api/v2/witness/route.ts:483` and never touches
`res.leaf_signature`, which `lib/scruple/witness.ts:68-70` declares and
types.

The discarded signatures are real. Verified here against the key the
witness publishes at `/api/signer/pubkey`, with no Scruple cooperation
beyond fetching that PEM:

```
b432f4b0d549410b  VERIFIES against the published key
ad3e91afb4833d3c  VERIFIES against the published key
976186c6109f0b94  VERIFIES against the published key
4427c838cdd0a2b0  VERIFIES against the published key
   key: ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaa…
```

⚠️ **That key is the CVM surrogate's software key.** `leaf_signer_surrogate
= 1` on every row. These leaves are third-party checkable and they are
**not hardware-backed**, and nothing in this addon records them as
anything else.

**So WO-B3's instruction to "keep `leaf_signature` / `leaf_signer_key_id`
/ `leaf_signature_alg`" is not achievable client-side today, and
`01-GAP.md`'s Table 3 row 1 was wrong to call H-1 a purely client-side
gap.** The read path is written and tested against a mock server that
does disclose (`register_v2_disclosing`), so the addon reads the fields
the day a route carries them. Until then it records
`source: "not_disclosed"`, which is a third answer distinct from a null:
*nobody was asked and nobody answered*, as against *the server says there
is none*. A panel that printed "unsigned" here would be inventing a fact.

---

## The canonicalization profile

Recorded, and it needed sending the workflow to become recordable at all.

Before B3 the workflow was only ever folded into
`machine_manifest_hash` and never transmitted, so `workflow_hash` was
NULL and the row's `canonicalization_profile` was NULL with it
(`route.ts:556`: `workflowHash ? CANONICALIZATION_PROFILE : null`). The
addon now sends the workflow as `graph`. All four rows carry `jcs-2`.

**The labels disagree; the rules do not.**

```
client (scruple_api.canonical.CANONICALIZATION_PROFILE)   jcs-1
server (iterations.canonicalization_profile)              jcs-2
```

Both implement RFC 8785. `jcs-2` is the same serializer extended to two
more preimages, so the *name* moved and the Python constant did not. The
addon cannot resolve this at runtime — **no v2 route returns the
profile** — so `CanonicalizationRecord` carries both, `server` is `None`,
and `agrees` is `None` rather than `True`. An unanswerable question is
not an agreement.

What *can* be shown is that the two canonicalizers produce the same
bytes. The addon records `client_workflow_hash`, computed locally with
`scruple_api.canonical.hash_workflow` over exactly what it sent; the
harness compares it against `iterations.workflow_hash`:

```
leaf 15  client == server      leaf 17  client == server
leaf 16  client == server      leaf 18  client == server
  (the four pairs of 64-hex digests are in 03-l2-evidence.json under
   leaves[].canonicalization.client_workflow_hash and leaves[].app_row.workflow_hash;
   the harness check is `client_and_server_workflow_hashes_agree`)
```

Confirmed separately on a document containing `1e-5` and `3.0` — the two
values `docs/canon/CANONICALIZATION.md` says the languages historically
disagreed on. So a verifier holding the graph can reproduce the hash in
either language today, and the divergence is in the label an auditor
reads to know *which rule to replay*. It should be closed by moving
`scruple_api` to `jcs-2`, in `scruple-web`, not here.

### One thing that changed about what leaves the machine

Sending the graph is new, and `build_save_workflow` /
`build_export_workflow` put an **absolute path** in `filepath`.
`/api/v2/witness` is a zero-content surface whose whole argument is that
the user's material stays put, and a directory layout is the user's
material. `flow.graph_for_wire()` reduces those to a basename before
sending. Control: `test_an_absolute_path_is_not_sent_to_the_server`
asserts no absolute path appears **anywhere** in the request body, and
goes red when the redaction is removed.

---

## The measurement states: five, of which three are the WO's three

`WitnessOutcome` gives `witnessed` and `queued`. That is not enough to be
honest, so `adapter/assurance.py` carries five:

| state | means | can it come back? |
|---|---|---|
| `witnessed` | delivered; the server said it wrote a leaf | — |
| `delivered_not_witnessed` | delivered 2xx; the server did **not** witness | no, not by itself |
| `queued` | not delivered; spooled on disk | **yes**, WO-B4 drains it |
| `rejected` | delivered and refused (4xx). Not spooled | **no** |
| `refused_locally` | never left this machine | **no** |

The last two are the additions and they are not padding. Collapsing
`rejected` into `queued` tells a user their capture is coming back when
it never will — which is exactly the state every pre-B3 render was in.
Collapsing `refused_locally` into silence is vendor floor item 5's
failure: a session that stopped witnessing looks like a quiet afternoon.

`adapter/state.py` keeps one record per capture **including the
refusals** — deliberately a second list beside the SDK's
`recent_receipts`, because the SDK writes a receipt only inside
`witness_file()` and a capture refused before that call produces none.

---

## What was built

| file | what |
|---|---|
| `adapter/assurance.py` *(new, 330 lines)* | `LeafAssurance`, `SignatureRecord`, `CanonicalizationRecord`, the five states, and the tier rule |
| `adapter/flow.py` | the `kind` mapping and its client-side refusal; `graph_for_wire()`; assurance on every path; `fetch_receipt()` / `verify_content()` / `resolve_assurance()` |
| `adapter/state.py` | the per-session capture tracker and `state_counts()` |
| `operators/verify.py` *(new)* | `scruple.verify_last` — fetch the receipt, run the check, report the claim as a claim |
| `panels/main.py` | the tracker rows carry the state and the tier; a one-line footer says why every tier reads `undisclosed` |
| `tests/mocks/v2.py` | the closed enum enforced; the invented `canonicalization_profile` removed; `/receipt` and `/verify` added; `register_v2_disclosing()` for the read path |
| `tests/mocks/http_mock.py` | prefix routes (the two v2 routes carry an id in the path) and `Rejected`, so a mock route cannot describe a 400 and answer 200 |
| `tests/test_assurance.py` *(new, 34 tests)* | this WO's gate |
| `tests/live/witness_l2_in_blender.py` *(new)* | the real run: renders, witnesses, reads both databases, verifies the discarded signatures, runs the one-pixel control |

**Suite: 214 passed** (176 at the end of WO-B2 → +34 assurance, +4
operator/panel).

### The mock was more generous than the server, and that is how this shipped

`tests/mocks/v2.py` accepted any `kind` and returned a
`canonicalization_profile` the real route does not send. 176 green tests
were compatible with an addon that could not witness anything. The mock
now refuses what the route refuses and omits what the route omits;
`register_v2_disclosing()` is a *separate* function for the hypothetical
generous server, so the default keeps telling the truth about today's.

---

## Controls — every must-fire check paired with a must-NOT-fire one

Each was broken, the suite run, and the change reverted
(`03-controls.log`):

| broken | went red |
|---|---|
| `render` maps back to the non-enum kind | **20** tests, across `test_assurance`, `test_flow`, `test_handlers`, `test_operators` |
| `assurance_tier` always returns `verified` | 3 |
| `/verify`'s claim is promoted to `checked` | 2 |
| `graph_for_wire` stops redacting the absolute path | 1 |
| a local refusal is not recorded on the tracker | 2 |
| *(live)* `render` maps back, run against the real stack | `every_leaf_witnessed`, `original_verifies_found` |

Reverted: `214 passed`.

A seventh control fired without being asked to. In the live
`kind`-reverted run, `baseline_is_the_measured_surface` also went false —
`attach()` found the tenant's existing baseline and reported drift,
because `flow.py` had been edited and `vendor/` plus `adapter/` are
inside `TAMPER_SURFACE_PATHS`. D-3 drift detection working on a real
edit, observed by accident.

---

## What this WO did NOT do

- **H-4 client-binding is not closed.** No component envelope, no
  ratchet, no MAC. Every leaf here is `component_verified: false`, which
  the record states rather than omits. Unchanged from `01-GAP.md` row 4,
  and still the item to put in front of the founder.
- **No leaf is `verified`.** The surrogate signs with a software key and
  says so; no attestation is supplied; the tier rule requires both and
  gets neither. `test_the_tier_is_never_verified_without_both_an_attestation_and_a_signature`
  is exhaustive over the two inputs.
- **The queue is filled and drained on `unregister()` only.**
  Reconciliation — a missing leaf **detected** rather than silently
  absent — is **WO-B4**. A `queued` capture is now at least *visible* on
  the tracker, which it was not.
- **The panel is not rebuilt.** The tier and the states are surfaced;
  project switching, price display and receipt drill-down are **WO-B5**.
- **Payment is untouched.** `/api/stripe/*` still authenticates by
  session cookie, so priced modalities remain unexercisable headless.

## Three things for the founder

1. **`/api/v2/verify` overstates.** It calls an HMAC-sealed leaf
   independently verifiable. Fixing it needs `iterations` to carry the
   H-1 triple (a migration), `app/api/v2/witness/route.ts` to stop
   discarding `res.leaf_signature`, and the verify route to key off that
   column. Until then no client can honestly render that field, and this
   one refuses to.
2. **`scruple_api` says `jcs-1`, the server writes `jcs-2`.** The bytes
   agree; the labels do not. One line in `packages/scruple-api`, plus
   deciding whether a v2 route should return the profile at all — nothing
   does today, so no client can record what its own leaf was hashed under.
3. **Nothing in `/api/v2` returns the leaf signature or the profile.**
   Both are stored. Neither is readable. An integration cannot be more
   honest than the API lets it be, and this is currently the ceiling.

## How to reproduce

```
$ cd /data/scruple-blender && bash build/build_addon.sh
$ SCRUPLE_APP_URL=http://127.0.0.1:3902 \
  SCRUPLE_B3_API_KEY=<a key with witness:write on the scratch app> \
  SCRUPLE_B3_BASE=/mnt/corpus/scruple-blender-l2/b3 \
  SCRUPLE_SCRATCH_DB=/mnt/corpus/scruple-blender-l2/scruple-scratch.db \
  SCRUPLE_WITNESS_DB=/mnt/corpus/scruple-blender-l2/witness-scratch.db \
  blender --background --factory-startup \
          --python tests/live/witness_l2_in_blender.py
```

The scratch witness must be started with H-1 leaf signing pointed at the
CVM surrogate, which the runner does **not** do by default — with it
disabled every leaf is HMAC-only and `/api/v2/verify` still says
`independently_verifiable: true`, which is the bug above:

```
$ cd /opt/scruple-witness && PORT=5899 DB_PATH=…/witness-scratch.db \
    SCRUPLE_WITNESS_ALLOW_DEV_SECRET=1 \
    SCRUPLE_WITNESS_KMS_ENDPOINT=http://127.0.0.1:8799 \
    SCRUPLE_WITNESS_KMS_KEY_OCID=ocid1.key.oc1.us-surrogate-1.surrogate.aaaaaaaaSURROGATEKEYnotarealkey \
    SCRUPLE_WITNESS_KMS_PUBKEY_URL=http://127.0.0.1:8799/testnet/pubkey.pem \
    node server.js
$ curl -s :5899/api/signer
{"mode":"kms-http","surrogate":true,"independently_verifiable":true,"self_check":{"ok":true,…}}
```
